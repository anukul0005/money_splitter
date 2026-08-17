# Static registry mapping known member names to their notification email + initials.
# Extend this as more people join the group; matching is case-insensitive on full name.

PEOPLE = {
    "anukul gupta": {"initials": "AG", "email": "anukul0005@gmail.com"},
    "anubhav singh": {"initials": "AS", "email": "anubha.singh10@gmail.com"},
}


def person_info(name: str) -> dict | None:
    return PEOPLE.get((name or "").strip().lower())
