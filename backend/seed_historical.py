"""
Seed historical data from Recovery&Loans.xlsx into the database.

Groups created:
 1. Jul-Aug 2024 Expenses      — Anukul, Ajay
 2. Sep-Oct 2024 Expenses      — Anukul, Ajay
 3. Oct-Dec 2024 Expenses      — Anukul, Ajay
 4. Dec 2024-Feb 2025 Expenses — Anukul, Ajay
 5. Feb-May 2025 Outings       — Anukul, Ajay, Anubhav, Renu
"""

import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from database import get_engine, create_tables
from models import Group, Member, Expense
from sqlalchemy.orm import sessionmaker

engine  = get_engine()
create_tables()
Session = sessionmaker(bind=engine)
db      = Session()

def make_group(name, emoji, members, category="other", is_historical=True):
    g = Group(name=name, emoji=emoji, category=category, is_historical=is_historical)
    db.add(g)
    db.flush()
    for m in members:
        db.add(Member(group_id=g.id, name=m))
    return g

def add_expense(group, date, amount, paid_by, divider, category=None, title=None, notes=None):
    divider = max(1, int(round(divider)))
    individual = round(amount / divider, 2)
    db.add(Expense(
        group_id=group.id,
        date=date,
        amount=round(amount, 2),
        paid_by=paid_by,
        divider=divider,
        individual_amount=individual,
        category=category,
        title=title,
        notes=notes,
    ))

# ─── Group 1: Jul-Aug 2024 ───────────────────────────────────────────────────
g1 = make_group("Jul-Aug 2024 Expenses", "💰", ["Anukul", "Ajay"])

expenses_g1 = [
    # date        amount  paid_by   div  category  title              notes
    ("2024-07-21",  147,  "Anukul",  2,  None,     None,              None),
    ("2024-07-23", 4368,  "Anukul",  3,  None,     None,              "Bill paid by Vineet"),
    ("2024-07-23", 1261,  "Anukul",  3,  None,     None,              None),
    ("2024-07-24",  776,  "Anukul",  3,  None,     None,              None),
    ("2024-07-25",  720,  "Ajay",    2,  None,     None,              None),
    ("2024-07-26",  326,  "Ajay",    3,  None,     None,              None),
    ("2024-07-27",  550,  "Anukul",  3,  None,     None,              None),
    ("2024-07-28",  280,  "Ajay",    2,  None,     None,              None),
    ("2024-07-29",  418,  "Ajay",    2,  None,     None,              None),
    ("2024-07-30",  210,  "Anukul",  2,  None,     None,              None),
    ("2024-07-31",   30,  "Ajay",    2,  None,     None,              None),
    ("2024-08-13",  420,  "Ajay",    2,  None,     None,              None),
    ("2024-08-31",  400,  "Ajay",    3,  None,     None,              None),
    ("2024-08-31",  810,  "Anukul",  2,  None,     None,              None),
    ("2024-08-31",  775,  "Anukul",  3,  None,     None,              None),
]
for row in expenses_g1:
    add_expense(g1, *row)

# ─── Group 2: Sep-Oct 2024 ───────────────────────────────────────────────────
g2 = make_group("Sep-Oct 2024 Expenses", "💰", ["Anukul", "Ajay"])

expenses_g2 = [
    ("2024-09-01",  576,  "Ajay",    2,  None, None, None),
    ("2024-09-08", 1250,  "Anukul",  2,  None, None, None),
    ("2024-09-08",  220,  "Ajay",    2,  None, None, None),
    ("2024-09-10", 2050,  "Anukul",  2,  None, None, None),
    ("2024-09-10",  115,  "Ajay",    2,  None, None, None),
    ("2024-09-15", 1240,  "Anukul",  2,  None, None, None),
    ("2024-09-15",  769,  "Anukul",  3,  None, None, None),
    ("2024-09-25", 1171,  "Anukul",  3,  None, None, None),
    ("2024-10-04",  650,  "Anukul",  2,  None, None, None),
    ("2024-10-05",   30,  "Ajay",    2,  None, None, None),
    ("2024-10-07",   50,  "Ajay",    2,  None, None, None),
    ("2024-10-07",  787,  "Anukul",  3,  None, None, None),
    ("2024-10-09",  335,  "Anukul",  1,  None, None, "Solo expense"),
    ("2024-10-09",  320,  "Anukul",  2,  None, None, None),
]
for row in expenses_g2:
    add_expense(g2, *row)

# ─── Group 3: Oct-Dec 2024 ───────────────────────────────────────────────────
g3 = make_group("Oct-Dec 2024 Expenses", "💰", ["Anukul", "Ajay"])

expenses_g3 = [
    ("2024-10-11",  769,  "Anukul",  2,  None, None, None),
    ("2024-10-11",   30,  "Anukul",  2,  None, None, None),
    ("2024-10-12",  110,  "Ajay",    2,  None, None, None),
    ("2024-10-15",  230,  "Ajay",    2,  None, None, None),
    ("2024-10-15",  910,  "Anukul",  2,  None, None, None),
    ("2024-10-21",  220,  "Ajay",    2,  None, None, None),
    ("2024-10-22",  234,  "Ajay",    3,  None, None, None),
    ("2024-10-25",  310,  "Ajay",    2,  None, None, None),
    ("2024-10-25",  310,  "Anukul",  2,  None, None, None),
    ("2024-11-04", 1290,  "Anukul",  2,  None, None, None),
    ("2024-11-06",  190,  "Anukul",  2,  None, None, None),
    ("2024-11-08", 1380,  "Anukul",  3,  None, None, None),
    ("2024-11-12",  720,  "Anukul",  2,  None, None, None),
    ("2024-11-29", 1500,  "Anukul",  1,  None, None, "Solo expense"),
    ("2024-12-09",  450,  "Anukul",  2,  None, None, None),
    ("2024-12-16",  630,  "Anukul",  2,  None, None, None),
]
for row in expenses_g3:
    add_expense(g3, *row)

# ─── Group 4: Dec 2024-Feb 2025 ──────────────────────────────────────────────
# Rows 56-58 in sheet show year 2025 for Dec 26-27 — almost certainly a typo for Dec 2024
g4 = make_group("Dec 2024-Feb 2025 Expenses", "💰", ["Anukul", "Ajay"])

expenses_g4 = [
    ("2024-12-26",  660,  "Anukul",  3,  None, None, None),
    ("2024-12-26",  632,  "Anukul",  2,  None, None, None),
    ("2024-12-27", 1277,  "Anukul",  3,  None, None, None),
    ("2025-01-12", 1235,  "Anukul",  3,  None, None, None),
    ("2025-01-21",  200,  "Anukul",  2,  None, None, None),
    ("2025-01-26", 1270,  "Anukul",  3,  None, None, None),
    ("2025-02-11",  240,  "Anukul",  2,  None, None, None),
    ("2025-02-18",  770,  "Anukul",  3,  None, None, None),
]
for row in expenses_g4:
    add_expense(g4, *row)

# ─── Group 5: Feb-May 2025 Outings ───────────────────────────────────────────
g5 = make_group("Feb-May 2025 Outings", "🍻", ["Anukul", "Ajay", "Anubhav", "Renu"],
                category="outing", is_historical=False)

expenses_g5 = [
    # date         amount  paid_by   div  category   title               notes
    ("2025-02-18",  190,  "Ajay",    2,  "Snacks",  "Chinese",          None),
    ("2025-02-18",  190,  "Ajay",    2,  "Snacks",  "Chinese",          None),
    ("2025-02-18",  390,  "Anukul",  3,  "Movie",   "STKasam",          None),
    ("2025-02-19",   30,  "Ajay",    2,  "Tea",     None,               None),
    ("2025-02-19",  250,  "Anukul",  2,  "Snacks",  None,               None),
    ("2025-02-22",  487,  "Ajay",    2,  "Food",    "BBKilo",           None),
    ("2025-02-26",  330,  "Anukul",  3,  "Snacks",  "Dominos",          None),
    ("2025-03-26",  550,  "Anukul",  2,  "Drinks",  "Vka - Canvas",     None),
    ("2025-03-27", 1000,  "Anukul",  1,  "Petrol",  "Shifting (vijay)", "To be fully paid by Ajay"),
    ("2025-03-28",  510,  "Anukul",  3,  "Drinks",  "R Reserve",        "Drinks with Anubhav"),
    ("2025-03-28",  220,  "Anukul",  2,  "Snacks",  None,               None),
    ("2025-03-29",  240,  "Anukul",  3,  "Food",    None,               "Party with Anubhav, incomplete info"),
    ("2025-05-10", 1900,  "Anukul",  3,  "Snacks",  "Cafe Wink",        None),
    ("2025-05-10",  620,  "Ajay",    2,  "Drinks",  "Budweiser",        None),
    ("2025-05-21", 1914,  "Ajay",    3,  "Snacks",  "Khao Piyo",        "0.4 share for Ronaldo"),
    ("2025-05-21",  600,  "Anukul",  3,  "Drinks",  "R. Reserve",       None),
    ("2025-05-21",  400,  "Anubhav", 3,  "Drinks",  "R. Reserve",       None),
    ("2025-05-21",  250,  "Ajay",    3,  "Drinks",  "Legacy",           None),
    ("2025-05-21",  787,  "Ajay",    2,  "Food",    "Postman",          "0.5 share for Ronaldo"),
    ("2025-05-21",  110,  "Anukul",  3,  "Snacks",  "Khoka",            None),
]
for row in expenses_g5:
    add_expense(g5, *row)

# ─── Commit ───────────────────────────────────────────────────────────────────
db.commit()

print("Done! Groups created:")
for g in [g1, g2, g3, g4, g5]:
    db.refresh(g)
    exp_count = len(g.expenses)
    total     = sum(e.amount for e in g.expenses)
    print(f"  [{g.id}] {g.name}  — {exp_count} expenses, ₹{total:,.0f} total")
