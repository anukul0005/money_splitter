"""How much of each source document actually made it into the price tables.

The parser reports what it kept. That number is reassuring and says nothing:
the rows it silently dropped are exactly the ones nobody would notice missing.
Tequila was absent from both states for months because "tequila" was not in
the category list, and the only symptom was a bottle you could not find.

So this counts from the other end. It walks every line of both PDFs, decides
which ones look like a priced product row, and accounts for each of those:
either it is in state_prices.py, or there is a stated reason it is not. A
line that is neither is a hole, and the summary names it.

Being at 100% is not the goal and would be a lie - these documents genuinely
carry rows that are not retail bottles (bulk spirit, canteen stock, sizes
nobody sells). The goal is that every dropped line has a reason attached and
somebody has looked at the list of reasons.

    python audit_source_coverage.py           # summary and the holes
    python audit_source_coverage.py --all     # every dropped line, grouped
"""

from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import pypdf

import state_prices
from brand_names import key as bn_key
from parse_state_rates import (
    EXCLUDE_NAME, KEEP_SIZES, LIST_TAIL, MP_PDF, UNIT_END, UP_PDF, _category,
)

# A line that mentions a bottle size and at least one number that could be a
# price. Deliberately broad - the point is to over-collect candidates and then
# explain each one, not to re-implement the parser's judgement here.
CANDIDATE = re.compile(r"\b(\d{2,4})\s*ML\b", re.I)
HAS_MONEY = re.compile(r"\d+\.\d{2,3}|\b\d{2,6}\b")


def lines(path: Path) -> list[str]:
    return [ln.strip() for p in pypdf.PdfReader(str(path)).pages
            for ln in (p.extract_text() or "").splitlines() if ln.strip()]


def stored_keys() -> set[tuple[str, str, int]]:
    """(state, brand key, size) for everything that reached the table."""
    return {(r[3], bn_key(r[0]), r[2]) for r in state_prices.ROWS}


def stored_words(state: str) -> set[str]:
    """Every distinctive word of every stored brand in this state.

    Used to ask a weaker question than an exact match: does this line's
    product appear in the table *at all*, under whatever spelling the parser
    settled on? Names get rewritten between the PDF and the table - joined
    across wrapped lines, canonicalised, location prefixes stripped - so
    exact-matching a raw line against the output would report holes that are
    not holes.
    """
    out: set[str] = set()
    for r in state_prices.ROWS:
        if r[3] == state:
            out.update(w for w in bn_key(r[0]).split() if len(w) > 3)
    return out


def audit(path: Path, state: str, show_all: bool) -> dict:
    raw = lines(path)
    stored = stored_keys()
    words = stored_words(state)
    in_state = {(s, k, z) for (s, k, z) in stored if s == state}

    reasons: Counter[str] = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    seen = 0

    for ln in raw:
        m = CANDIDATE.search(ln)
        if not m or not HAS_MONEY.search(ln):
            continue
        seen += 1
        size = int(m.group(1))

        # Does anything from this line appear in the table? Judged on the
        # distinctive words, because the stored name is rarely the raw one.
        toks = [w for w in bn_key(ln).split() if len(w) > 3 and not w.isdigit()]
        hit = any(w in words for w in toks)
        if hit and any(z == size for (_, _, z) in in_state):
            reasons["kept"] += 1
            continue

        # Not there. Say which of the parser's rules accounts for it.
        #
        # The UP document's own rules come first, because they are the ones
        # that reject the most: a row whose retail price or excise duty prints
        # as 0.000 is registered rather than on sale, and a row whose
        # manufacturer column does not end in a company word cannot be split
        # into maker and brand at all.
        tail = LIST_TAIL.match(ln)
        if tail:
            nums = tail.group("nums").split()
            if float(nums[-1]) <= 0 or float(nums[0]) <= 0:
                reasons["registered, but no retail price printed"] += 1
                continue

        if size not in KEEP_SIZES:
            why = f"size {size}ml is not a retail bottle size"
        elif EXCLUDE_NAME.search(ln):
            why = "not on retail sale (export / canteen / duty free)"
        elif _category(ln) is None:
            why = "no category could be read from the name"
        elif tail and not UNIT_END.match(
                re.sub(r"^\d+\s+", "", tail.group("pre")[:CANDIDATE.search(
                    tail.group("pre")).start()]).strip()
                if CANDIDATE.search(tail.group("pre")) else ""):
            why = "maker and brand share a column and could not be split"
        elif hit:
            why = f"product is in the table, but not at {size}ml"
        else:
            why = "UNEXPLAINED - looks like a product row and is not stored"
        reasons[why] += 1
        if len(examples[why]) < (40 if show_all else 6):
            examples[why].append(ln[:150])

    return {"state": state, "candidates": seen,
            "reasons": reasons, "examples": examples}


def main(show_all: bool) -> int:
    print(f"state_prices.py holds {len(state_prices.ROWS)} rows\n")
    holes = 0
    for path, state in ((UP_PDF, "Uttar Pradesh"), (MP_PDF, "Madhya Pradesh")):
        r = audit(path, state, show_all)
        kept = r["reasons"]["kept"]
        seen = r["candidates"]
        print("=" * 72)
        print(f"{r['state']}  ·  {path.name}")
        print(f"  {seen} candidate product lines, {kept} accounted for in the "
              f"table ({kept / seen:.0%})")
        for why, n in r["reasons"].most_common():
            if why == "kept":
                continue
            flag = "  !!" if why.startswith("UNEXPLAINED") else "    "
            print(f"{flag} {n:5}  {why}")
            for e in r["examples"][why]:
                print(f"            {e}")
            if why.startswith("UNEXPLAINED"):
                holes += n
        print()

    print("=" * 72)
    if holes:
        print(f"{holes} lines look like products and have no stated reason for "
              f"being absent.\nThose are the ones worth reading.")
    else:
        print("Every dropped line has a stated reason. Nothing is silently "
              "missing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main("--all" in sys.argv))
