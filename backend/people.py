# Static registry mapping known member names to their notification email + initials.
# Extend this as more people join the group; matching is case-insensitive and keyed
# on whatever name string is actually stored on the Member record (e.g. "Anukul",
# not necessarily the full "Anukul Gupta").

PEOPLE = {
    "anukul": {"initials": "AG", "email": "anukul0005@gmail.com"},
    "anubhav": {"initials": "AS", "email": "anubha.singh10@gmail.com"},
}


def person_info(name: str) -> dict | None:
    return PEOPLE.get((name or "").strip().lower())
