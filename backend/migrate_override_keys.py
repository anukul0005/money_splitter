"""Re-key the hand-entered prices, and merge the duplicates that forked.

A correction's identity is its `brand_key`. That key used to be computed by a
looser rule than the one the rest of the app matches names with - it dropped
full stops and apostrophes and nothing else - so anything else typed into the
name forked the row. "Bacardi Orange Rum (5%)" and "Bacardi Orange Rum" became
two corrections, at one price, for one bottle.

_brand_key now delegates to brand_names.key, which strips a strength printed
into the name and splits digits off letters. New writes are safe. The rows
already stored still carry keys computed the old way, so this recomputes them
and merges anything that collides.

Merging keeps the newest row, because a correction is somebody telling us a
price and the most recent telling is the one to believe. Anything the survivor
is missing - a strength, a note - is carried over from the row being dropped
rather than thrown away.

Size is never merged. The same brand in 180ml and 750ml is two prices for one
brand, and collapsing those would lose a real number.

Run once:  python migrate_override_keys.py --apply
Without --apply it only reports.
"""

from __future__ import annotations

import sys
from collections import defaultdict

from brand_names import key as bn_key
from database import get_session_factory
from models import PriceOverride


def _stamp(r: PriceOverride):
    """Newest-first sort key. Falls back to the id when there are no dates."""
    return (r.updated_at or r.created_at, r.id)


def main(apply: bool) -> int:
    db = get_session_factory()()
    rows = db.query(PriceOverride).all()
    print(f"{len(rows)} corrections stored")

    groups: dict[tuple[str, str, int], list[PriceOverride]] = defaultdict(list)
    for r in rows:
        groups[(bn_key(r.brand), r.state, r.size_ml)].append(r)

    rekeyed = merged = 0
    for (key, state, size), items in sorted(groups.items()):
        items.sort(key=_stamp, reverse=True)
        keep, drop = items[0], items[1:]

        if drop:
            merged += len(drop)
            print(f"\nmerge  {state} {size}ml  ->  {keep.brand!r}")
            for d in drop:
                print(f"       dropping {d.brand!r} (id {d.id}, Rs {d.price:g})")
                # Don't lose what only the older row knew.
                if keep.abv is None and d.abv is not None:
                    keep.abv = d.abv
                if not keep.note and d.note:
                    keep.note = d.note
                if apply:
                    db.delete(d)

        if keep.brand_key != key:
            rekeyed += 1
            print(f"rekey  {keep.brand!r}: {keep.brand_key!r} -> {key!r}")
            keep.brand_key = key

    print(f"\n{rekeyed} re-keyed, {merged} merged away, "
          f"{len(groups)} corrections afterwards")
    if apply:
        db.commit()
        print("committed")
    else:
        print("dry run - pass --apply to write")
    return 0


if __name__ == "__main__":
    raise SystemExit(main("--apply" in sys.argv))
