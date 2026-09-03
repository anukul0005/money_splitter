"""The knowledge base: every food and drink expense, as a searchable vector.

WHAT THIS IS FOR
The recommender's two tables — published liquor prices and published
restaurant listings — are static. They know what a bottle costs in UP; they do
not know that you and Anubhav drank Old Monk in March and paid Rs 700 for it.
That second thing is the only part a generic recommender cannot have, and
until now it was reachable only through hand-written regexes.

So every expense that mentions food or drink is embedded and stored. New
expenses are indexed as they are written, so tonight's dinner is part of the
knowledge base before the next recommendation is asked for. Nothing has to be
rebuilt by hand.

WHAT THE VECTORS ARE, HONESTLY
These are lexical embeddings, not neural ones: hashed word and character
n-grams, sublinear term frequency, L2 normalised. No model is downloaded and
nothing is sent to an API, which is what makes this run inside a 512MB free
tier at all.

That is the right tool for this particular job. Matching "old monk 750" to
"OLD MONK THE ORIGINAL PREMIUM STRONG BEER" is a lexical problem — the words
really are the same words, just buried — and character n-grams handle the
misspellings and abbreviations people type into an expense box. What they
genuinely cannot do is semantics: they will not learn that "nightcap" means
whisky. `embed()` is the single seam to replace if that becomes worth paying
for; nothing else in this file would change.

WHY 2048 DIMENSIONS
Measured, not guessed. Hashed features collide, and collisions are the whole
error budget here: at 384 dimensions "momos" matched "Karim's" at 0.34 while
the real "vat69" -> "VAT 69 BLENDED SCOTCH WHISKY" match scored 0.17, so the
false pair outranked the true one. Widening fixes it. Across a set of true and
false pairs:

    384   true min 0.304   false max 0.338   margin -0.034
    1536  true min 0.304   false max 0.169   margin +0.135
    2048  true min 0.304   false max 0.075   margin +0.229
    4096  true min 0.304   false max 0.075   margin +0.229

2048 is where the separation stops improving, and it costs half of what 4096
does to store (8KB a row, so about 40MB at five thousand expenses). The match
threshold sits at 0.25, comfortably inside that gap.

STORAGE
pgvector, which Neon has. Cosine distance is computed by the database with the
`<=>` operator. At a few hundred rows an index would be pointless — the planner
would ignore it — so there is none yet; add IVFFlat or HNSW somewhere north of
a hundred thousand rows.
"""

from __future__ import annotations

import json
import re
import zlib
from functools import lru_cache

import numpy as np
from sqlalchemy import text as sql
from sqlalchemy.orm import Session

DIMS = 2048

# ── What counts as a drink or a meal ──────────────────────────────────────────
# These live here rather than in the routers because both routers and the
# indexer have to agree on the answer. One definition, imported everywhere.

# Deliberately \b-bounded: an unbounded "gin" matched "Monginis", a bakery, and
# put cake in the liquor data.
DRINK_RE = re.compile(
    r"\b(vat\s*69|bacardi|whisky|whiskey|rum|beer|vodka|gin|wine|old\s*monk|"
    r"blenders?|magic\s*moments?|breezer|tuborg|kingfisher|budweiser|corona|"
    r"jack\s*daniel|black\s*label|red\s*label|royal\s*stag|imperial\s*blue|"
    r"8\s*pm|mcdowell|antiquity|glenlivet|jameson|smirnoff|liquor|alcohol|"
    r"booze|daru|thek|absolut|j&b|chivas|100\s*pipers|officer'?s\s*choice|"
    r"bagpiper|captain\s*morgan|grey\s*goose|glenfiddich|black\s*dog)\b",
    re.I,
)

# Excludes bare "bar" and "pub", which are drinks runs and counted above.
FOOD_RE = re.compile(
    r"\b(food|lunch|dinner|breakfast|brunch|meal|restaurant|resto|dhaba|"
    r"cafe|café|eat|eating|swiggy|zomato|order(?:ed|ing)?\s*in|takeaway|"
    r"pizza|burger|biryani|biriyani|momo|momos|roll|rolls|thali|buffet|"
    r"chinese|paneer|chicken|kebab|kabab|tikka|butter\s*chicken|chole|"
    r"bhature|paratha|parantha|dosa|idli|sandwich|pasta|noodles|ramen|sushi|"
    r"barbeque|barbecue|bbq|dessert|ice\s*cream|cake|bakery|snacks?|"
    r"domino'?s|mcdonald'?s|kfc|subway|burger\s*king|haldiram'?s|bikaner|"
    r"barbeque\s*nation|social|starbucks|chaayos|keventers)\b",
    re.I,
)

# Bought to cook, not to eat out. Half the "snacks" in the data are a Zepto run
# and raw chicken, which say nothing about where to eat.
GROCERY_RE = re.compile(
    r"\b(grocery|groceries|bigbasket|big\s*basket|blinkit|zepto|instamart|"
    r"dmart|d.?mart|kirana|supermarket|sabzi|vegetables?|ration|atta|"
    r"raw|milk|eggs)\b",
    re.I,
)

DRINK, FOOD = "drink", "food"

# Words that appear in half the expenses and discriminate nothing. Kept out of
# the vector so "Food expense Food" does not look like every other row.
STOP = {
    "expense", "expenses", "misc", "miscellaneous", "bill", "paid", "pay",
    "for", "and", "the", "with", "from", "of", "to", "in", "on", "at", "a",
    "rs", "inr", "amount", "total", "cost", "share", "split", "cash",
}


def _norm(s: str) -> str:
    """Lowercase, punctuation to spaces, letters split from digits.

    That last part is not cosmetic. People type "vat69" and "750ml"; the
    catalogue says "VAT 69" and holds the size separately. Without the split
    those share almost no shingles and the true match scored 0.17 - below
    several false ones.
    """
    s = re.sub(r"[^a-z0-9]+", " ", (s or "").lower())
    s = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", s)
    return " ".join(s.split())


def _features(s: str) -> list[str]:
    """Words, word pairs, and 4-character shingles inside each word.

    The character shingles are what make this robust to how people actually
    type: "oldmonk", "old monk", "Old Monk 750" and a misspelling all share
    most of their shingles.
    """
    words = [w for w in _norm(s).split() if w not in STOP]
    if not words:
        return []
    out: list[str] = [f"w:{w}" for w in words]
    out += [f"b:{a}_{b}" for a, b in zip(words, words[1:])]
    for w in words:
        if len(w) >= 3:
            padded = f"^{w}$"
            out += [f"c:{padded[i:i + 4]}" for i in range(len(padded) - 3)]
    return out


def embed(s: str) -> list[float]:
    """A unit-length vector for one piece of text.

    crc32 rather than hash(): Python randomises string hashing per process, so
    hash() would produce a different vector every restart and silently poison
    everything already stored.
    """
    vec = np.zeros(DIMS, dtype=np.float32)
    counts: dict[int, float] = {}
    for f in _features(s):
        d = zlib.crc32(f.encode()) % DIMS
        counts[d] = counts.get(d, 0.0) + 1.0
    for d, c in counts.items():
        vec[d] = 1.0 + np.log(c)          # sublinear: ten mentions isn't ten times
    n = float(np.linalg.norm(vec))
    if n > 0:
        vec /= n
    return [round(float(x), 6) for x in vec]


def to_literal(vec: list[float]) -> str:
    """pgvector accepts its own text form, so no extra driver is needed."""
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


def classify(t: str) -> str | None:
    """drink, food, or neither. Drink wins a tie - a bar tab is a drinks run."""
    if GROCERY_RE.search(t):
        return None
    if DRINK_RE.search(t):
        return DRINK
    if FOOD_RE.search(t):
        return FOOD
    return None


# ── Linking an expense to the published catalogue ─────────────────────────────
@lru_cache(maxsize=1)
def _catalogue() -> tuple[list[tuple[str, str]], np.ndarray]:
    """Every brand and restaurant we hold, embedded once.

    Built lazily so importing this module stays cheap, and cached because the
    catalogue is static for the life of the process.
    """
    from food_prices import PLACES
    from liquor_prices import BOTTLES

    names: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for b in BOTTLES:
        key = (DRINK, b.brand.lower())
        if key not in seen:
            seen.add(key)
            names.append((DRINK, b.brand))
    for p in PLACES:
        key = (FOOD, p.name.lower())
        if key not in seen:
            seen.add(key)
            names.append((FOOD, p.name))

    matrix = np.array([embed(n) for _, n in names], dtype=np.float32)
    return names, matrix


# How good a cross-category match has to be before it may overrule the
# regexes. Well above the 0.25 needed merely to name a bottle: changing what
# something *is* deserves a higher bar than labelling it.
REFILE_FLOOR = 0.45


def _best(t: str, kind: str) -> tuple[str | None, float]:
    """Nearest catalogue entry of one kind, with its cosine score."""
    names, matrix = _catalogue()
    mask = np.array([k == kind for k, _ in names])
    if not mask.any():
        return None, 0.0
    q = np.array(embed(t), dtype=np.float32)
    sims = matrix[mask] @ q                     # both sides are unit length
    idx = int(np.argmax(sims))
    return [n for (k, n), m in zip(names, mask) if m][idx], float(sims[idx])


def link(t: str, kind: str, floor: float = 0.25) -> tuple[str | None, float, str]:
    """The catalogue entry this expense is most likely talking about.

    Returns (name, score, kind) - the kind because retrieval is allowed to
    overrule the regexes on category. "Beer Cafe" is a restaurant, but the
    word "beer" makes DRINK_RE claim it first, and it was being linked to a
    lager. The vectors know better: when the other catalogue matches clearly
    more strongly, the expense is refiled.

    Clearly, not marginally. A small edge either way is noise at these
    scores, so the other side has to win by a real margin before a category
    the regexes were confident about is overturned.

    Nothing is returned below `floor`. A weak match is worse than no match:
    it would attach a real brand to the wrong expense and then present it as
    something you buy.
    """
    other = FOOD if kind == DRINK else DRINK
    a_name, a_score = _best(t, kind)
    b_name, b_score = _best(t, other)
    # Refiling needs a match that is strong on its own, not merely stronger
    # than a weak one. Two near-misses differing by a tenth is noise, and
    # letting that flip a category put popcorn, samosas and a taxi to the
    # office in the drinks list: "office" looks like "Officer's Choice" and
    # "Bombay to barca" like "Bombay Special Whisky" at around 0.31, which
    # was enough under the old rule. Beer Cafe matches its own name far above
    # this, which is the case the rule exists for.
    if b_score >= REFILE_FLOOR and b_score > a_score + 0.10:
        a_name, a_score, kind = b_name, b_score, other
    if a_score < floor:
        return None, a_score, kind
    return a_name, a_score, kind


# Words that describe the category, not the thing. A suggestion reading "food
# expense food" or "snacks" is not a suggestion, so these are stripped out of
# a fallback label and an entry left with nothing gets no label at all - which
# keeps it out of `learned` entirely.
GENERIC = {
    "food", "foods", "drink", "drinks", "snack", "snacks", "meal", "meals",
    "lunch", "dinner", "breakfast", "brunch", "eat", "eating", "order",
    "bill", "party", "outing", "trip", "day", "night", "evening", "morning",
    "extra", "other", "others", "item", "items", "stuff", "thing", "things",
}


def _label(t: str) -> str | None:
    """A short, human name for an expense that matched nothing in the catalogue.

    The whole normalised sentence made a terrible suggestion label — "seth
    sethani petrol beer zomato kinara" is not something you can go and buy.
    So: drop the category words, keep the first few that are left, and if
    nothing distinctive survives, admit there is no label.
    """
    words = [w for w in _norm(t).split()
             if w not in STOP and w not in GENERIC and not w.isdigit()]
    if not words:
        return None
    return " ".join(words[:4])


# ── Indexing ──────────────────────────────────────────────────────────────────
def expense_text(e) -> str:
    return " ".join(filter(None, [e.title, e.category, e.notes]))


def index_expense(db: Session, expense, group_id: int | None = None) -> str | None:
    """Add or refresh one expense in the knowledge base.

    Returns the kind it was filed under, or None if it is not food or drink.
    An expense that stops looking like food - retitled, say - is removed rather
    than left behind as a stale row.

    Deliberately swallows its own errors at the call site, not here: indexing
    is a side effect of saving an expense, and a knowledge base problem must
    never stop somebody recording what they spent.
    """
    from models import KnowledgeItem

    t = expense_text(expense)
    kind = classify(t)
    row = (db.query(KnowledgeItem)
             .filter(KnowledgeItem.expense_id == expense.id)
             .first())

    if kind is None:
        # It used to look like food and no longer does - retitled, or the
        # classifier tightened. Drop it rather than leave a stale row that
        # would keep turning up in retrieval.
        if row is not None:
            db.delete(row)
        return None

    # Retrieval may refile this: see link(). "Beer Cafe" arrives here as a
    # drink and leaves as food.
    brand, score, kind = link(t, kind)
    heads = max(int(expense.divider or 1), 1)
    if row is None:
        row = KnowledgeItem(expense_id=expense.id)
        db.add(row)
    row.group_id = group_id if group_id is not None else expense.group_id
    row.kind = kind
    row.title = t[:500]
    row.label = brand or _label(t)
    row.matched_brand = brand
    row.match_score = round(score, 4)
    row.amount = float(expense.amount or 0)
    row.per_head = round(float(expense.amount or 0) / heads, 2)
    row.occurred_on = expense.date
    db.flush()                       # need row.id before the raw vector write

    db.execute(
        sql("UPDATE knowledge_items SET embedding = CAST(:v AS vector) "
            "WHERE id = :i"),
        {"v": to_literal(embed(t)), "i": row.id},
    )
    return kind


def reindex_all(db: Session) -> dict:
    """Rebuild the whole knowledge base from every expense in every group.

    Idempotent - safe to run repeatedly. Used for the first backfill and any
    time the classifier or the embedding changes.
    """
    from models import Expense

    counts = {DRINK: 0, FOOD: 0, "skipped": 0}
    for e in db.query(Expense).all():
        kind = index_expense(db, e)
        counts[kind if kind else "skipped"] += 1
    db.commit()
    return counts


# ── Search ────────────────────────────────────────────────────────────────────
def search(db: Session, query: str, kind: str | None = None,
           group_ids: list[int] | None = None, limit: int = 20,
           floor: float = 0.15) -> list[dict]:
    """Nearest expenses to a phrase, by cosine similarity.

    `group_ids` is not optional in practice: the caller passes the groups the
    signed-in person belongs to, and an empty list returns nothing. The
    knowledge base spans everybody's expenses, so search has to be scoped the
    same way every other read in this app is.
    """
    if group_ids is not None and not group_ids:
        return []

    where = ["embedding IS NOT NULL"]
    params: dict = {"q": to_literal(embed(query)), "lim": limit}
    if kind:
        where.append("kind = :kind")
        params["kind"] = kind
    if group_ids is not None:
        where.append("group_id = ANY(:gids)")
        params["gids"] = group_ids

    rows = db.execute(sql(f"""
        SELECT id, expense_id, group_id, kind, title, label, amount, per_head,
               occurred_on, matched_brand,
               1 - (embedding <=> CAST(:q AS vector)) AS score
        FROM knowledge_items
        WHERE {' AND '.join(where)}
        ORDER BY embedding <=> CAST(:q AS vector)
        LIMIT :lim
    """), params).mappings().all()

    return [dict(r) for r in rows if r["score"] >= floor]


def learned(db: Session, kind: str, group_ids: list[int],
            lo: float, hi: float, per_head: bool = False,
            limit: int = 8) -> list[dict]:
    """Things you have actually bought, priced from what you actually paid.

    This is the knowledge base answering the recommender's question directly
    rather than only ranking the published tables. A brand or a place you have
    bought before, whose typical spend lands inside the budget, is a real
    suggestion — often a better one than a catalogue row, because the price is
    what you were charged rather than what a list says.

    The number is spend, not a shelf price. One expense can be a round for six
    or a single bottle, and nothing here can tell which, so the API calls it
    spend and the page must too.

    Grouped by `label`, which is the catalogue name where the text linked to
    one and the cleaned phrase otherwise. That is what lets "old monk", "Old
    Monk 750" and "oldmonk" collapse into one suggestion instead of three.
    """
    if not group_ids:
        return []

    # Only things that linked to the catalogue are offered as suggestions.
    # An expense the vectors could not name still gets indexed and is still
    # searchable - it just does not become advice. "Seth sethani petrol beer
    # zomato kinara" is a real evening and a useless recommendation, and the
    # bar for putting a name in front of somebody as a thing to go and buy is
    # that we can actually name it.
    col = "per_head" if per_head else "amount"
    rows = db.execute(sql(f"""
        SELECT matched_brand                   AS label,
               MAX(matched_brand)              AS matched_brand,
               COUNT(*)                        AS times,
               AVG({col})                      AS avg_spend,
               MIN({col})                      AS min_spend,
               MAX({col})                      AS max_spend,
               MAX(occurred_on)                AS last_had
        FROM knowledge_items
        WHERE kind = :kind AND group_id = ANY(:gids)
          AND matched_brand IS NOT NULL
        GROUP BY matched_brand
        HAVING AVG({col}) BETWEEN :lo AND :hi
        ORDER BY COUNT(*) DESC, MAX(occurred_on) DESC NULLS LAST
        LIMIT :lim
    """), {"kind": kind, "gids": group_ids, "lo": lo, "hi": hi,
           "lim": limit}).mappings().all()

    return [{
        "label": r["label"],
        "matched_brand": r["matched_brand"],
        "times": r["times"],
        "avg_spend": round(float(r["avg_spend"]), 2),
        "min_spend": round(float(r["min_spend"]), 2),
        "max_spend": round(float(r["max_spend"]), 2),
        "last_had": r["last_had"],
        "from_history": True,
    } for r in rows]


def stats(db: Session) -> dict:
    rows = db.execute(sql("""
        SELECT kind, COUNT(*) AS n, COUNT(matched_brand) AS linked,
               MIN(occurred_on) AS first_seen, MAX(occurred_on) AS last_seen
        FROM knowledge_items GROUP BY kind
    """)).mappings().all()
    total = db.execute(sql("SELECT COUNT(*) FROM knowledge_items")).scalar()
    return {
        "total": total or 0,
        "dims": DIMS,
        "by_kind": {r["kind"]: dict(r) for r in rows},
    }


if __name__ == "__main__":  # pragma: no cover - a look at the vectors
    for a, b in [("old monk", "OLD MONK THE ORIGINAL PREMIUM STRONG BEER"),
                 ("oldmonk 750", "Old Monk"),
                 ("vat69", "VAT 69 BLENDED SCOTCH WHISKY"),
                 ("momos", "Karim's"),
                 ("chinese dinner", "Asia Kitchen")]:
        va, vb = np.array(embed(a)), np.array(embed(b))
        print(f"{float(va @ vb):.3f}  {a!r} vs {b!r}")
    print()
    print(json.dumps({"features": _features("Old Monk 750ml Snacks")[:8]}, indent=2))
