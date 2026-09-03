"""Generate the knowledge-base (RAG) architecture PDF.

    ../venv/Scripts/python.exe make_rag_pdf.py

Writes knowledge-base-architecture.pdf next to this file. Needs fpdf2, which
is a documentation-only dependency and deliberately not in requirements.txt -
the running app must not need it.

Core PDF fonts are Latin-1 only, so this file writes "Rs" rather than the
rupee sign and plain hyphens rather than dashes. Every figure here was
measured against the live database; nothing is illustrative.
"""

from __future__ import annotations

from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

OUT = Path(__file__).with_name("knowledge-base-architecture.pdf")

INK    = (18, 21, 28)
MUTED  = (107, 116, 130)
SIGNAL = (14, 124, 134)      # a true match
COLLIDE = (164, 64, 90)      # a hash collision
RULE   = (226, 230, 237)
BOX    = (243, 246, 249)


class Doc(FPDF):
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*MUTED)
        self.cell(0, 6, "SplitEasy - Retrieval on Receipts", align="R")
        self.ln(8)

    def footer(self):
        self.set_y(-14)
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*MUTED)
        self.cell(0, 6, f"{self.page_no()}", align="C")


def h1(p: Doc, text: str):
    p.set_font("Helvetica", "B", 19)
    p.set_text_color(*INK)
    p.multi_cell(0, 8.5, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(1.5)


def h2(p: Doc, num: str, text: str):
    if p.get_y() > 232:
        p.add_page()
    p.ln(3)
    p.set_font("Courier", "B", 8.5)
    p.set_text_color(*SIGNAL)
    p.cell(14, 6.4, num)
    p.set_font("Helvetica", "B", 12.5)
    p.set_text_color(*INK)
    p.multi_cell(0, 6.4, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.set_draw_color(*RULE)
    p.line(p.l_margin, p.get_y() + 0.6, p.w - p.r_margin, p.get_y() + 0.6)
    p.ln(3)


def body(p: Doc, text: str, size: float = 9.6):
    if p.get_y() > 265:
        p.add_page()
    p.set_font("Helvetica", "", size)
    p.set_text_color(*INK)
    p.multi_cell(0, 4.9, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(1.6)


def bullet(p: Doc, text: str):
    if p.get_y() > 266:
        p.add_page()
    p.set_font("Helvetica", "", 9.6)
    p.set_text_color(*INK)
    x = p.get_x()
    p.cell(4.5, 4.9, "-")
    p.set_x(x + 4.5)
    p.multi_cell(0, 4.9, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(0.4)


def mono(p: Doc, lines: list[str]):
    """Fixed-width block on a tinted panel - diagrams, SQL, sample output."""
    p.ln(1)
    h = len(lines) * 4.3 + 5
    if p.get_y() + h > 274:
        p.add_page()
    p.set_fill_color(*BOX)
    p.set_draw_color(*RULE)
    p.rect(p.l_margin, p.get_y(), p.w - p.l_margin - p.r_margin, h, style="DF")
    p.ln(2.5)
    p.set_font("Courier", "", 7.8)
    p.set_text_color(*INK)
    for ln in lines:
        p.set_x(p.l_margin + 3)
        p.cell(0, 4.3, ln)
        p.ln(4.3)
    p.ln(3)


def note(p: Doc, label: str, text: str, colour=COLLIDE):
    """A finding, marked by a rule in the colour of what it is."""
    if p.get_y() > 250:
        p.add_page()
    p.ln(1)
    y0 = p.get_y()
    p.set_x(p.l_margin + 4)
    p.set_font("Helvetica", "B", 7.6)
    p.set_text_color(*colour)
    p.multi_cell(p.w - p.l_margin - p.r_margin - 4, 4.2, label.upper(),
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.set_x(p.l_margin + 4)
    p.set_font("Helvetica", "", 9.4)
    p.set_text_color(*INK)
    p.multi_cell(p.w - p.l_margin - p.r_margin - 4, 4.7, text,
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.set_draw_color(*colour)
    p.set_line_width(0.7)
    p.line(p.l_margin, y0, p.l_margin, p.get_y())
    p.set_line_width(0.2)
    p.ln(2.5)


def table(p: Doc, headers: list[str], rows: list[list[str]], widths: list[float],
          highlight: int | None = None):
    if p.get_y() + len(rows) * 5.4 + 12 > 274:
        p.add_page()
    p.set_font("Helvetica", "B", 7.8)
    p.set_text_color(*MUTED)
    for hd, w in zip(headers, widths):
        p.cell(w, 5.4, hd.upper())
    p.ln(5.4)
    p.set_draw_color(*RULE)
    p.line(p.l_margin, p.get_y(), p.w - p.r_margin, p.get_y())
    p.ln(1.2)
    for i, row in enumerate(rows):
        if i == highlight:
            p.set_fill_color(*BOX)
            p.rect(p.l_margin, p.get_y() - 0.6,
                   p.w - p.l_margin - p.r_margin, 5.6, style="F")
        for j, (cell, w) in enumerate(zip(row, widths)):
            p.set_font("Courier" if j else "Helvetica",
                       "B" if i == highlight else "", 8.4)
            p.set_text_color(*INK)
            p.cell(w, 5.4, cell)
        p.ln(5.4)
    p.ln(3)


def build() -> Path:
    p = Doc(format="A4")
    p.set_auto_page_break(auto=True, margin=18)
    p.set_margins(20, 18, 20)
    p.add_page()

    # ── Title ────────────────────────────────────────────────────────────
    p.ln(22)
    p.set_font("Courier", "B", 9)
    p.set_text_color(*SIGNAL)
    p.multi_cell(0, 5, "SPLITEASY / ENGINEERING NOTE",
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(4)
    p.set_font("Helvetica", "B", 30)
    p.set_text_color(*INK)
    p.multi_cell(0, 12, "Retrieval on Receipts",
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(3)
    p.set_font("Helvetica", "", 11.5)
    p.set_text_color(*MUTED)
    p.multi_cell(0, 5.8,
                 "How every food and drink expense became a searchable vector, "
                 "and how that vector store started answering the question the "
                 "price tables never could.",
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(8)
    mono(p, [
        "  497   expenses scanned          2048   dimensions per vector",
        "  180   indexed as vectors           1   new dependency (numpy)",
        "   36   drink / 144 food          0.8.0  pgvector, on Neon",
    ])
    p.ln(2)
    p.set_font("Helvetica", "", 8.6)
    p.set_text_color(*MUTED)
    p.multi_cell(0, 4.4,
                 "September 2026. Every figure measured against the live "
                 "database, not estimated.",
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    # ── Why ──────────────────────────────────────────────────────────────
    p.add_page()
    h2(p, "WHY", "The tables know prices. They don't know you.")
    body(p,
         "The recommender already stood on two solid tables: 961 Uttar Pradesh "
         "liquor prices parsed from the state's own PDFs, and 66 Delhi NCR "
         "restaurants with cited costs for two. Both are public, static and "
         "correct.")
    body(p,
         "Neither knows that you and Anubhav drank Old Monk in March and paid "
         "Rs 675. That second thing is the half a generic recommender can never "
         "have - and until now the only route to it was a hand-written regex, "
         "roughly forty lines of alternation that had already been patched three "
         "times for exactly the mistakes a person would never make:")
    bullet(p, "'gin' matching Monginis, a bakery, putting cake in the liquor data")
    bullet(p, "'social' matching an unrelated expense and inventing a favourite restaurant")
    bullet(p, "'Export' as a channel marker versus Tuborg Mild Export Beer, an actual beer")
    body(p,
         "Each fix was correct and each was reactive. A regex encodes the "
         "failures you have already seen. The point of this work is a "
         "representation that generalises to the ones you haven't.")

    h2(p, "MAP", "The shape of the whole thing")
    body(p, "Seven stages. The first four run when an expense is saved; the last "
            "three run when a recommendation is asked for.")
    mono(p, [
        "  EXPENSE SAVED",
        "      |",
        "      +--> 01 CLASSIFY    drink, food, or neither",
        "      +--> 02 FEATURISE   words, pairs, 4-char shingles",
        "      +--> 03 EMBED       hash -> 2048 floats, unit length",
        "      +--> 04 LINK        nearest catalogue entry, cosine",
        "      +--> 05 STORE       pgvector column, one row per expense",
        "",
        "  RECOMMENDATION ASKED",
        "      |",
        "      +--> 06 RETRIEVE    cosine, scoped to your groups",
        "      +--> 07 RECOMMEND   your spend, inside tonight's budget",
    ])
    body(p,
         "One new dependency across the whole build: numpy. No model is "
         "downloaded, nothing is sent to an API, and nothing needs a GPU - which "
         "is the only reason it fits inside a 512 MB free tier that also spins "
         "down when idle.")

    # ── 01 ───────────────────────────────────────────────────────────────
    h2(p, "01", "Deciding what is even food")
    body(p,
         "The regexes did not disappear - they were promoted. All three now live "
         "in one module and are imported by both routers and the indexer, because "
         "the indexer and the recommender agreeing on the answer matters more "
         "than either answer being clever.")
    body(p,
         "Classification is deliberately coarse: drink, food, or nothing. "
         "Groceries are excluded outright - half the 'snacks' in your data are a "
         "Zepto run or raw chicken, which say a great deal about your kitchen and "
         "nothing about which restaurant to pick.")
    table(p, ["Bucket", "Rows", "What it is"],
          [["drink", "36", "Bottles, rounds, bar tabs"],
           ["food", "144", "Meals out, deliveries, snacks"],
           ["skipped", "317", "Fuel, rent, cabs, groceries"]],
          [42, 24, 100])
    body(p,
         "Two thirds of your expenses are correctly ignored. An index that "
         "swallowed everything would retrieve confidently and uselessly.")

    # ── 02 ───────────────────────────────────────────────────────────────
    h2(p, "02", "Turning a scrap of text into features")
    body(p,
         "Expense titles are not sentences. They are things like "
         "'newbrandtry(half)+momos+chips' and 'oldmonk 750'. Three feature "
         "families, chosen for that reality:")
    mono(p, [
        '  "Old Monk 750ml Snacks"',
        "",
        "    normalise  ->  old monk 750 ml snacks",
        "",
        "    words      w:old  w:monk  w:750  w:ml  w:snacks",
        "    pairs      b:old_monk  b:monk_750  b:750_ml",
        "    shingles   c:^old  c:old$  c:^mon  c:monk  c:onk$  ...",
    ])
    body(p,
         "The four-character shingles are what make this survive contact with "
         "real typing. 'oldmonk', 'old monk' and a misspelling share most of "
         "their shingles even when they share no whole word.")
    note(p, "One line that mattered more than any other",
         "Normalisation splits letters from digits: vat69 -> vat 69, "
         "750ml -> 750 ml. People type it closed up; the catalogue prints it "
         "open. Without that split the true match vat69 -> VAT 69 BLENDED SCOTCH "
         "WHISKY scored 0.17, which was below several false matches. With it, "
         "0.30 before any other change.", SIGNAL)

    # ── 03 ───────────────────────────────────────────────────────────────
    h2(p, "03", "From features to a vector")
    body(p, "Each feature is hashed to a dimension, weighted by how often it "
            "occurs, and the whole vector is scaled to unit length.")
    mono(p, [
        "    d    = crc32(feature) mod 2048",
        "    v[d] = 1 + ln(count)",
        "    v    = v / ||v||",
    ])
    bullet(p, "crc32, not Python's hash(). String hashing is randomised per "
              "process, so hash() would produce a different vector after every "
              "restart and silently poison everything already stored.")
    bullet(p, "1 + ln(count) is sublinear: a word appearing ten times is more "
              "important than once, but not ten times more.")
    bullet(p, "Unit length means cosine similarity is just the dot product - no "
              "division at query time, and long titles stop beating short ones "
              "on length alone.")
    body(p,
         "This is the classic hashing trick. It has one real cost, which turned "
         "out to be the whole story of the next stage: two different features can "
         "land on the same dimension, and the vector cannot tell them apart.")

    # ── 04 ───────────────────────────────────────────────────────────────
    h2(p, "04", "Choosing 2048, by measurement")
    body(p,
         "I first picked 384 dimensions for a bad reason: it is the width of "
         "all-MiniLM-L6-v2, so a neural model could be swapped in later without "
         "migrating the column. Forward-compatibility is a real consideration. "
         "It is not a reason to ship a broken retriever.")
    note(p, "What 384 dimensions actually did",
         "'momos' matched Karim's at 0.338, while the true 'vat69' -> VAT 69 "
         "BLENDED SCOTCH WHISKY scored 0.172. The false pair outranked the true "
         "one. There is no threshold that rescues that - any cut-off admitting "
         "the truth also admits the nonsense.")
    body(p,
         "So I built a set of true and false pairs and measured. The margin is "
         "the gap between the worst true match and the best false one; below zero "
         "means no threshold can separate them.")
    table(p, ["Dims", "True min", "False max", "Margin", "Per row", "Verdict"],
          [["384",  "0.304", "0.338", "-0.034", "1.5 KB", "Unusable"],
           ["1536", "0.304", "0.169", "+0.135", "6 KB",   "Workable"],
           ["2048", "0.304", "0.075", "+0.229", "8 KB",   "Chosen"],
           ["4096", "0.304", "0.075", "+0.229", "16 KB",  "No gain, 2x cost"]],
          [20, 24, 25, 24, 22, 44], highlight=2)
    body(p,
         "2048 is exactly where separation stops improving. 4096 buys nothing and "
         "costs double. The match threshold sits at 0.25, comfortably inside a "
         "gap running from 0.075 to 0.304.")
    body(p,
         "At 8 KB a row that is about 1.4 MB today and roughly 40 MB at five "
         "thousand expenses - against a 500 MB free tier currently 1.6% used. "
         "Storage is not the constraint and won't be for years.")

    # ── 05 ───────────────────────────────────────────────────────────────
    h2(p, "05", "Why lexical, and where the seam is")
    body(p,
         "These are lexical embeddings, not neural ones. That deserves saying "
         "plainly, because 'embedding' has come to imply a transformer.")
    body(p,
         "Two reasons, one practical and one principled. The practical one: "
         "Render's free tier is 512 MB and sentence-transformers pulls in torch "
         "at roughly 800 MB. It does not fit, and there is no API key in play.")
    body(p,
         "The principled one matters more. Matching 'old monk 750' to OLD MONK "
         "THE ORIGINAL PREMIUM STRONG BEER is a lexical problem. The words "
         "genuinely are the same words, just buried in a registered label. "
         "Character shingles handle the abbreviations and misspellings people "
         "type into an expense box. A neural model would spend a great deal of "
         "compute rediscovering that the string 'old monk' appears in both.")
    table(p, ["Query", "Catalogue entry", "Cosine"],
          [["old monk",       "OLD MONK THE ORIGINAL ... BEER", "0.465"],
           ["oldmonk 750",    "Old Monk",                       "0.426"],
           ["vat69",          "VAT 69 BLENDED SCOTCH WHISKY",   "0.430"],
           ["chinese dinner", "Asia Kitchen",                   "0.075"],
           ["momos",          "Karim's",                        "0.000"]],
          [38, 88, 22])
    body(p,
         "What this genuinely cannot do is semantics. It will never learn that "
         "'nightcap' means whisky, or that a Riesling and a Chardonnay are "
         "neighbours. When that becomes worth paying for, embed() is the single "
         "function to replace - everything downstream takes a list of floats and "
         "does not care where they came from.")

    # ── 06 ───────────────────────────────────────────────────────────────
    h2(p, "06", "Linking, and letting retrieval overrule the rules")
    body(p,
         "Every catalogue entry - 961 bottles and 66 restaurants - is embedded "
         "once and cached. A new expense is compared against all of them, and the "
         "nearest entry above 0.25 becomes its canonical label. That is what "
         "collapses 'old monk', 'Old monk Drinks' and 'oldmonk 750' into a single "
         "suggestion instead of three.")
    body(p, "Then the real data produced something better than the design.")
    note(p, "Found in your expenses",
         "'Beer Cafe' is a restaurant in Cyber Hub. But DRINK_RE sees the word "
         "beer and claims it first, so it was classified as a drink and dutifully "
         "linked to Stok Lager Beer - a plausible, confident, wrong answer that "
         "would have appeared as something you drink.")
    note(p, "The fix",
         "Retrieval is now allowed to overrule the regex. Each expense is scored "
         "against both catalogues, and if the other side wins by a clear margin - "
         "0.10, not a hair - the expense is refiled. 'Beer Cafe' now classifies "
         "as food and links to The Beer Cafe. The margin matters: a small edge "
         "either way is noise at these scores, and a category the regex was "
         "confident about should not flip on noise.", SIGNAL)
    body(p,
         "A second flaw showed up in the same pass. Expenses with nothing "
         "distinctive in them - 'Food expense Food', 'snacks' - were becoming "
         "suggestions that literally read 'food expense food'. Category words are "
         "now stripped from any fallback label, and an entry with nothing left "
         "over gets no label at all, which keeps it out of the results entirely. "
         "A suggestion you cannot act on is worse than one fewer suggestion.")

    # ── 07 ───────────────────────────────────────────────────────────────
    h2(p, "07", "Storage: pgvector, and no index")
    body(p,
         "Vectors live in a vector(2048) column on Neon, which already had "
         "pgvector 0.8.0 available. Cosine distance is computed by the database "
         "with the <=> operator, so ranking never travels over the wire.")
    mono(p, [
        "  SELECT label, amount, occurred_on,",
        "         1 - (embedding <=> CAST(:q AS vector)) AS score",
        "  FROM   knowledge_items",
        "  WHERE  kind = :kind",
        "    AND  group_id = ANY(:gids)     -- the whole security model",
        "  ORDER BY embedding <=> CAST(:q AS vector)",
        "  LIMIT  :lim",
    ])
    body(p,
         "There is deliberately no vector index. At 180 rows an IVFFlat or HNSW "
         "index would be ignored by the planner and would cost accuracy for "
         "nothing; exact search over a few hundred rows is already "
         "sub-millisecond. That decision is worth revisiting somewhere north of a "
         "hundred thousand rows, which on your current pace is a long way off.")
    body(p,
         "No pgvector Python package either. The extension accepts its own text "
         "form, so the vector is written with a cast - the only raw SQL in the "
         "codebase, and contained to one file.")

    # ── 08 ───────────────────────────────────────────────────────────────
    h2(p, "08", "Staying live")
    body(p,
         "The knowledge base would be worth much less if it needed rebuilding by "
         "hand. Indexing hangs off the expense write path, inside the same "
         "transaction, so an expense and its vector can never disagree.")
    bullet(p, "Create - indexed before commit. Tonight's drinks are retrievable "
              "before the next recommendation is asked for.")
    bullet(p, "Edit - re-indexed. An edit can change the amount, the date, or "
              "whether the thing is food at all.")
    bullet(p, "Delete - the row goes with it, by foreign key cascade.")
    bullet(p, "Reclassify - an expense that stops looking like food is removed, "
              "not left as a stale vector still answering the old question.")
    note(p, "A deliberate swallow",
         "Indexing failures are caught and logged, never raised. A knowledge-base "
         "problem must never be the reason somebody cannot record what they "
         "spent. The cost of failure is one row in a retrieval index that a "
         "reindex repairs; the cost of raising is a person's expense.", MUTED)
    body(p,
         "One row per expense, enforced by a unique constraint, so re-indexing "
         "updates rather than piling up. The full rebuild is idempotent and "
         "admin-only.")

    # ── 09 ───────────────────────────────────────────────────────────────
    h2(p, "09", "Retrieval becomes a recommendation")
    body(p,
         "This is the part that closes the loop. Indexed history no longer only "
         "ranks the published tables - it produces suggestions of its own. Things "
         "you have actually bought, grouped by canonical label, whose typical "
         "spend falls inside the budget you set:")
    mono(p, [
        "  Uttar Pradesh . 2 people . Rs 300-1200 . with Anubhav",
        "",
        "    Old Monk               x5   avg Rs 541   last 2026-03-15",
        "    Smirnoff               x3   avg Rs 620   last 2026-06-19",
        "    Budweiser Magnum Beer  x3   avg Rs 483   last 2026-04-20",
        "    Black Dog              x2   avg Rs 470   last 2026-08-20",
    ])
    note(p, "One word doing a lot of work",
         "The figure is spend, not a price. A single expense can be a round for "
         "six or one bottle, and nothing in the data can tell which. So the API "
         "calls it spend, the page calls it spend, and neither implies a shelf "
         "price it cannot support. This is the same discipline as the ~ in front "
         "of a restaurant estimate.", MUTED)
    body(p,
         "The effect is that a bottle nobody published a price for - a local "
         "label, a one-off, something from a shop that only you go to - becomes "
         "recommendable purely because you bought it and it fits tonight's "
         "budget.")

    # ── 10 ───────────────────────────────────────────────────────────────
    h2(p, "10", "Who can see what")
    body(p,
         "The index spans every expense in the app, across everybody's groups. "
         "Search is therefore scoped exactly the way every other read here is - "
         "to groups the caller belongs to. An unscoped vector search would be a "
         "very efficient way to read what other people drink.")
    table(p, ["Caller", "Hits", "Why"],
          [["Anukul",   "5", "In the groups those expenses live in"],
           ["Utkarsh",  "0", "Shares none of those groups"],
           ["unscoped", "0", "An empty group list returns nothing, by construction"]],
          [34, 20, 112])
    body(p,
         "The group id is denormalised onto every row precisely so this filter "
         "needs no join. The cheapest possible check is the one most likely to "
         "still be there in a year.")

    # ── End ──────────────────────────────────────────────────────────────
    h2(p, "END", "What this is not, and what comes next")
    p.set_font("Helvetica", "B", 9)
    p.set_text_color(*MUTED)
    p.multi_cell(0, 5, "HONEST LIMITS", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(1.5)
    bullet(p, "No semantics. Lexical vectors will not connect 'nightcap' to "
              "whisky. Replacing embed() is the upgrade path.")
    bullet(p, "No generation. Nothing here asks a language model. Retrieval picks "
              "rows; arithmetic is done in code. Every number on screen traces to "
              "a row or a receipt.")
    bullet(p, "The classifier is still regex. Retrieval can now overrule it on "
              "category, but the initial gate is unchanged. Embedding-based "
              "classification is the obvious next step.")
    bullet(p, "The backfill is slow: 176 seconds for 180 rows, one round trip to "
              "Neon per row. Fine as a one-off, and a batched write if it is ever "
              "run often.")
    p.ln(2)
    p.set_font("Helvetica", "B", 9)
    p.set_text_color(*MUTED)
    p.multi_cell(0, 5, "WHAT WOULD ACTUALLY EARN ITS KEEP NEXT",
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(1.5)
    body(p,
         "Not a bigger model. The highest-value thing left is a feedback loop "
         "this app is unusually well placed to close: it already records what "
         "people spend. Log which suggestions were shown, join that against the "
         "expenses that follow, and you learn whether the advice was taken - "
         "ground truth that most recommenders never see.")
    body(p,
         "That is a table and a join. It needs no vectors at all, and it is what "
         "would make the system genuinely learn rather than merely remember.")

    p.ln(4)
    p.set_draw_color(*RULE)
    p.line(p.l_margin, p.get_y(), p.w - p.r_margin, p.get_y())
    p.ln(3)
    p.set_font("Helvetica", "", 8)
    p.set_text_color(*MUTED)
    p.multi_cell(0, 4.2,
                 "SplitEasy - knowledge base built over 497 expenses, 180 "
                 "indexed, 2048 dimensions, pgvector 0.8.0 on Neon. All figures "
                 "measured against the live database, not estimated. Frontend "
                 "changes in this work are unverified: there is no Node "
                 "toolchain on the build machine, so the pages were checked by "
                 "bracket-balance against their committed versions rather than "
                 "compiled.",
                 new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    p.output(str(OUT))
    return OUT


if __name__ == "__main__":
    path = build()
    print(f"wrote {path.name} ({path.stat().st_size / 1024:.0f} KB)")
