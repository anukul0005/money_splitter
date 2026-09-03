"""One spelling per bottle, across every state.

Each source names the same drink differently. Delhi's list says "Royal Stag";
Madhya Pradesh's says "Seagrams Royal Stag Superior Whisky"; Uttar Pradesh's
says something else again. Left alone that is three brands, they never compare
across states, and the knowledge base fills up with duplicates of one bottle.

The rule: reduce a name to its identifying core by dropping the words that
describe rather than identify, and treat names sharing a core and a category
as one product. Whichever spelling is shortest becomes the one shown, because
the shortest is what people actually say.

Prices are untouched. The price is the one thing that legitimately varies from
state to state, and merging names must never merge those.

This module is imported at runtime by liquor_prices and at build time by
parse_state_rates, so the app and the parser cannot drift apart on what a
bottle is called. It deliberately depends on nothing.
"""

from __future__ import annotations

import re
from collections import defaultdict

# Words that say what kind of drink it is, or how good it claims to be.
# Neither identifies the product.
DESCRIPTORS = {
    # category
    "whisky", "whiskey", "rum", "vodka", "gin", "beer", "wine", "brandy",
    "lager", "ale", "bier", "pilsner", "stout", "scotch", "malt", "blend",
    "blended", "grain", "spirit", "spirits", "liqueur",
    # marketing
    "premium", "super", "extra", "strong", "superior", "deluxe", "delux",
    "special", "exclusive", "original", "classic", "reserve", "select",
    "fine", "rare", "aged", "smooth", "no", "no1", "the", "and", "of", "with",
    "triple", "double", "distilled", "matured", "craft", "crafted",
    "authentic", "pure", "xxx", "xo", "vsop", "edition", "collection",
    "heritage", "legendary", "ultra", "max", "light", "dry", "new",
    # manufacturer houses that sit in front of the brand
    "seagrams", "seagram", "seagrams'", "usl", "diageo", "pernod", "ricard",
}

# Brands built entirely out of descriptor words. Without this they collapse
# into each other or into nothing: "Black Dog" and "Black Label" both reduce
# to an empty core once "black" is dropped. Longest first, so "black label"
# is tested before any shorter phrase that is a prefix of it.
PROTECTED = tuple(sorted((
    "old monk", "black dog", "royal stag", "royal challenge", "blenders pride",
    "white mischief", "black label", "red label", "green label", "blue label",
    "royal salute", "old smuggler", "golden eagle", "red knight",
    "black & white", "imperial blue", "royal green", "white walker",
    "royal ranthambore", "old tavern", "director's special", "signature",
), key=len, reverse=True))


def key(name: str) -> str:
    """Lowercase, no punctuation, digits split off letters, single spaces.

    The digit split matters as much here as it does in the embeddings: people
    type "VAT69" and "8PM" while the lists print "VAT 69" and "8 PM". Without
    it those are different brands and a correction to one never reaches the
    other.
    """
    s = (name or "").lower().replace(".", "").replace("'", "")
    s = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", s)
    return " ".join(s.split())


def core(name: str, kind: str) -> str:
    """The identifying part of a brand name, tagged with its category.

    Category is part of the key deliberately: Old Monk rum and Old Monk beer
    are different products that would otherwise merge into one.
    """
    k = key(name)
    for keep in PROTECTED:
        if key(keep) in k:
            return f"{kind}|{key(keep)}"
    words = [w for w in k.split() if w not in DESCRIPTORS]
    # Everything was a descriptor - keep the whole name rather than merging
    # unrelated bottles under an empty core.
    return f"{kind}|{' '.join(words) if words else k}"


def display(names: list[str]) -> str:
    """The name to show for a cluster: the shortest, tidied for case.

    Shortest because it is what gets said out loud - "Royal Stag", not
    "Seagrams Royal Stag Superior Whisky". A name shouted in full capitals is
    title-cased; anything already carrying mixed case is left as published,
    since that is the brand's own styling.
    """
    best = min(names, key=lambda n: (len(n), n))
    if best.isupper():
        best = " ".join(w if any(c.isdigit() for c in w) else w.capitalize()
                        for w in best.split())
    return best


def canonicalise(pairs: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
    """Map every (name, kind) to the one spelling its cluster will use."""
    clusters: dict[str, list[str]] = defaultdict(list)
    for name, kind in pairs:
        clusters[core(name, kind)].append(name)
    chosen = {c: display(names) for c, names in clusters.items()}
    return {(name, kind): chosen[core(name, kind)] for name, kind in pairs}
