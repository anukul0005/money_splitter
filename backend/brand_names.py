"""One spelling per bottle, across every state.

Each source names the same drink differently. Delhi's list says "Royal Stag";
Madhya Pradesh's says "Seagrams Royal Stag Superior Whisky"; Uttar Pradesh's
says something else again. Left alone that is three brands, they never compare
across states, and the knowledge base fills up with duplicates of one bottle.

The rule is deliberately cautious: strip only the category noun, the
manufacturing house and filler, then treat names sharing what is left as one
product. That merges "SEAGRAM'S ROYAL STAG SUPERIOR WHISKY (NEW )" with
"Seagrams Royal Stag Superior Whisky" - genuinely the same bottle written
twice - while leaving Royal Stag Barrel Select as its own product.

Merging harder was tried and was a mistake. Treating "premium", "ultra" and
"strong" as noise collapsed twelve Kingfishers into one, which threw away the
difference between a 4.8% lager and an 8% strong at two different prices. The
detail in these names is the product information.

Prices are untouched. The price is the one thing that legitimately varies from
state to state, and merging names must never merge those.

This module is imported at runtime by liquor_prices and at build time by
parse_state_rates, so the app and the parser cannot drift apart on what a
bottle is called. It deliberately depends on nothing.
"""

from __future__ import annotations

import re
from collections import defaultdict

# Only what never distinguishes one product from another: the category noun,
# the manufacturing house, and grammatical filler.
#
# This list was once far longer and included "premium", "ultra", "strong",
# "reserve", "select" and their like. That was wrong, and badly so. In Indian
# liquor those words *are* the product: Kingfisher Ultra, Kingfisher Premium
# and Kingfisher Strong are three beers at three prices and three strengths,
# and dropping the adjective merged twelve published names into one. Royal
# Stag Barrel Select is not Royal Stag. The words that look like marketing are
# carrying the information.
#
# So the rule now is conservative: strip only what is provably not part of the
# name, and let two spellings of the *same* product merge while two different
# products stay apart. Matching a short name in one state against a long one
# in another is a separate job, done at query time where a near-match can be
# ranked instead of having to be decided once and for all.
DESCRIPTORS = {
    # the category noun - "Beer" in "Kingfisher Ultra Lager Beer"
    "whisky", "whiskey", "rum", "vodka", "gin", "beer", "wine", "brandy",
    "lager", "bier", "pilsner", "pilsener", "ale", "stout",
    # the house in front of the brand - "Seagram's 100 Pipers" is 100 Pipers
    "seagrams", "seagram", "usl", "diageo", "pernod", "ricard",
    # filler, and the "(NEW)" registrations carry
    "the", "and", "of", "with", "new",
}


def key(name: str) -> str:
    """Lowercase, punctuation gone, digits split off letters, single spaces.

    The digit split matters as much here as it does in the embeddings: people
    type "VAT69" and "8PM" while the lists print "VAT 69" and "8 PM". Without
    it those are different brands and a correction to one never reaches the
    other. Dropping punctuation outright is what lets "(NEW )" and "SEAGRAM'S"
    fall into line with the same name written plainly.
    """
    # Apostrophes are deleted, not spaced. Turning them into spaces left a
    # stray "s" token, so "Seagram's Royal Stag" and "Seagrams Royal Stag"
    # stayed two brands at the same price. Everything else becomes a space.
    s = (name or "").lower().replace("'", "").replace("’", "")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])", " ", s)
    return " ".join(s.split())


def core(name: str, kind: str) -> str:
    """The identifying part of a brand name, tagged with its category.

    Category is part of the key deliberately: Old Monk rum and Old Monk beer
    are different products that would otherwise merge into one.
    """
    k = key(name)
    words = [w for w in k.split() if w not in DESCRIPTORS]
    # Everything was a descriptor - keep the whole name rather than merging
    # unrelated bottles under an empty core.
    return f"{kind}|{' '.join(words) if words else k}"


def display(names: list[str]) -> str:
    """The name to show for a cluster: the shortest, tidied for case.

    A cluster now holds only spellings of one product, so the choice is
    between "Kingfisher Ultra Lager Beer" and "KINGFISHER ULTRA LAGER BEER."
    rather than between a product and a shorter, different one. Shortest picks
    the cleanest of the equivalents and loses nothing.

    A name shouted in full capitals is title-cased; anything already carrying
    mixed case is left as published, since that is the brand's own styling.
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
