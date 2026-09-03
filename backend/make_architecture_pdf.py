"""Generate the drink-recommender architecture PDF.

    ../venv/Scripts/python.exe make_architecture_pdf.py

Writes recommender-architecture.pdf next to this file. Needs fpdf2, which is
a documentation-only dependency and deliberately not in requirements.txt —
the running app must not need it.
"""

from __future__ import annotations

from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

OUT = Path(__file__).with_name("recommender-architecture.pdf")

INK      = (25, 32, 45)
MUTED    = (110, 122, 138)
BRAND    = (214, 96, 26)
RULE     = (222, 214, 200)
BOX      = (248, 245, 238)
GREEN    = (26, 122, 74)
RED      = (176, 48, 48)


class Doc(FPDF):
    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("Helvetica", "", 8)
        self.set_text_color(*MUTED)
        self.cell(0, 6, "SplitEasy - Drink Recommender Architecture", align="R")
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


def h2(p: Doc, text: str):
    if p.get_y() > 235:
        p.add_page()
    p.ln(3)
    p.set_font("Helvetica", "B", 12.5)
    p.set_text_color(*BRAND)
    p.multi_cell(0, 6.4, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.set_draw_color(*RULE)
    p.line(p.l_margin, p.get_y() + 0.6, p.w - p.r_margin, p.get_y() + 0.6)
    p.ln(3)


def body(p: Doc, text: str, size: float = 9.6):
    p.set_font("Helvetica", "", size)
    p.set_text_color(*INK)
    p.multi_cell(0, 4.9, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(1.6)


def bullet(p: Doc, text: str):
    p.set_font("Helvetica", "", 9.6)
    p.set_text_color(*INK)
    x = p.get_x()
    p.cell(4.5, 4.9, "-")
    p.set_x(x + 4.5)
    p.multi_cell(0, 4.9, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(0.4)


def mono(p: Doc, lines: list[str]):
    """Fixed-width block on a tinted panel — used for the diagrams."""
    p.ln(1)
    h = len(lines) * 4.3 + 5
    if p.get_y() + h > 275:
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


def kv_table(p: Doc, rows: list[tuple[str, str]], w1: float = 46):
    p.set_font("Helvetica", "", 9.4)
    for k, v in rows:
        if p.get_y() > 268:
            p.add_page()
        y = p.get_y()
        p.set_font("Helvetica", "B", 9.4)
        p.set_text_color(*INK)
        p.multi_cell(w1, 4.7, k, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        y2 = p.get_y()
        p.set_xy(p.l_margin + w1, y)
        p.set_font("Helvetica", "", 9.4)
        p.set_text_color(*MUTED)
        p.multi_cell(p.w - p.l_margin - p.r_margin - w1, 4.7, v, new_x=XPos.LMARGIN, new_y=YPos.NEXT)
        p.set_y(max(y2, p.get_y()) + 1.2)
    p.ln(1)


def build() -> Path:
    p = Doc(format="A4")
    p.set_auto_page_break(auto=True, margin=18)
    p.set_margins(18, 16, 18)
    p.add_page()

    # ── Title ────────────────────────────────────────────────────────────────
    p.set_font("Helvetica", "B", 25)
    p.set_text_color(*INK)
    p.multi_cell(0, 10.5, "Drink Recommender", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.set_font("Helvetica", "", 11.5)
    p.set_text_color(*MUTED)
    p.multi_cell(0, 5.6, "Architecture and design decisions - SplitEasy", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(1)
    p.set_font("Helvetica", "", 8.6)
    p.multi_cell(0, 4.4, "September 2026", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    p.ln(4)

    h2(p, "What it does")
    body(p,
         "You give it four things - which state you are in, who you are drinking with, how many "
         "people and what budget - and it answers the question you actually have: which bottles "
         "do I walk out of the shop with, and what will that cost each of us.")

    h2(p, "The one design decision that matters")
    body(p,
         "There is no language model anywhere in this feature.")
    body(p,
         "That was a deliberate choice, not a limitation. A model asked to recommend drinks will "
         "happily invent a price for a brand in a state it has never seen, and the answer will read "
         "exactly like a real one. For a feature whose entire job is money, that failure is worse "
         "than useless - it is confidently wrong.")
    body(p,
         "So every number here is either looked up in a table with a citation, or computed in code "
         "from your own recorded spending. Prices are read, arithmetic is done in Python, and the "
         "ranking is a sort you can read and argue with. Every figure on screen can be traced to a "
         "source URL or one of your own expenses.")

    h2(p, "The two data sources")
    body(p,
         "The recommender stands on two legs, and they do different jobs.")
    kv_table(p, [
        ("1. Price table",
         "backend/liquor_prices.py - a hand-curated table scraped from public state price "
         "listings. Answers 'what does this bottle cost here'."),
        ("2. Your history",
         "The expenses already in the app. Answers 'what do these particular people actually "
         "drink, and what do they normally spend'."),
    ])
    body(p,
         "The second is the one a generic app cannot copy. Knowing that you and Anubhav have had "
         "18 sessions averaging Rs 1,458 and keep buying Old Monk is worth more than any amount of "
         "general knowledge about whisky.")

    # ── Page 2: flow ─────────────────────────────────────────────────────────
    p.add_page()
    h2(p, "Request flow")
    mono(p, [
        "  BROWSER                     FastAPI                      DATA",
        "  ---------------             -------------------          -----------------",
        "",
        "  Recommend.jsx",
        "    state, people,",
        "    budget, strength,   --->  GET /recommend/",
        "    names[]                     |",
        "                                | 1. auth: who is calling?",
        "                                |    (token -> User)",
        "                                |",
        "                                | 2. _history(caller, names)  --->  Postgres",
        "                                |    scoped to groups you                (expenses)",
        "                                |    are a member of",
        "                                |",
        "                                | 3. for_state(state)         --->  liquor_prices",
        "                                |    rows for that state                (static table)",
        "                                |",
        "                                | 4. _pick(): bottles + price",
        "                                |    _best_combo() per brand",
        "                                |",
        "                                | 5. across_sizes(): the same",
        "                                |    basket in UP / DL / GGN",
        "                                v",
        "  render cards        <---  { history, picks[], compare[] }",
    ])

    h2(p, "Step 4 - choosing the bottles")
    body(p,
         "Spirits in India are sold in three sizes and everybody names them the same way. The "
         "recommender only ever suggests these:")
    kv_table(p, [
        ("180 ml", "quarter"),
        ("375 ml", "half"),
        ("750 ml", "full"),
    ], w1=26)
    body(p,
         "An evening's demand is estimated in millilitres - roughly one quarter a head for a normal "
         "night - but that number is never shown, because nobody buys 540 ml. It is a target that "
         "gets converted into whole bottles.")
    body(p,
         "_best_combo() then solves a tiny three-coin problem: which combination of quarters, halves "
         "and fulls covers the target most cheaply. With three denominations and small counts, brute "
         "force over the grid is exact and instant - no need for anything cleverer.")
    mono(p, [
        "  3 people, normal  ->  target 540 ml",
        "",
        "     1 full   750 ml   Rs 520     <- chosen: cheapest cover",
        "     1 half + 1 qtr    555 ml     Rs 555",
        "     3 qtr    540 ml   Rs 570",
    ])
    body(p,
         "Overshoot is allowed up to a half-bottle. A tighter cap looked more principled and was "
         "wrong in practice: it rejected a single full for three people, which overshoots by 210 ml "
         "and is obviously what anyone would buy.")

    # ── Page 3 ───────────────────────────────────────────────────────────────
    p.add_page()
    h2(p, "Step 5 - the NCR comparison")
    body(p,
         "Alcohol is a State subject in India. Every state sets its own excise duty and its own "
         "MRP, so the same bottle genuinely costs different amounts a short drive apart. That is "
         "not a rounding difference - it is often hundreds of rupees.")
    mono(p, [
        "  Royal Stag 750 ml        UP  650-720    Delhi 550-800    Gurugram 480-550",
        "  Blenders Pride 750 ml    UP  680-780    Delhi 550-800    Gurugram 730",
        "  Old Monk 750 ml          UP  520        Delhi 350-420    Gurugram  -",
    ])
    body(p,
         "So every suggestion is priced in all three NCR regions and the cheapest is highlighted. "
         "A dash means that region publishes no price for that exact bottle and size. It is never a "
         "number carried across from a neighbouring state, even though that would fill the grid "
         "more neatly.")
    body(p,
         "A region is only priced when it has every size in the basket. Pricing half a basket and "
         "estimating the rest would produce a total that reads as real and is not.")

    h2(p, "Honesty rules in the price table")
    bullet(p, "Every row cites a source URL and the month it was read.")
    bullet(p, "Nothing is interpolated between states. A missing state is a dash, not a guess.")
    bullet(p, "Where a source published a range, the range is kept rather than averaged away.")
    bullet(p, "Haryana sets a minimum selling price, not a fixed MRP, so shops legally differ and "
              "two honest sources disagreed. Those rows span both figures instead of one being "
              "picked and presented as the price.")
    body(p,
         "Current coverage: Delhi, Gurugram (Haryana), Uttar Pradesh and Maharashtra. "
         "Running 'python liquor_prices.py' prints coverage and every source, so the gaps are "
         "visible rather than implied.")

    h2(p, "Privacy")
    body(p,
         "History is computed only from groups the caller is a member of. Naming somebody you do "
         "not share a group with returns nothing about them - the endpoint cannot be used to read "
         "another person's drinking habits, in the same way the rest of the API cannot be used to "
         "read their balances.")

    h2(p, "Ranking")
    body(p, "The sort is three keys, in this order:")
    kv_table(p, [
        ("1. Familiar first", "Brands this set of people has actually bought before."),
        ("2. Right amount", "Closest total volume to what this many people would get through."),
        ("3. Cheapest", "Then price, ascending."),
    ])
    body(p,
         "History only appears on screen once you have named somebody. With nobody named it was "
         "the caller's own drinking across every group, shown as 'sessions together' with no one "
         "to have had them with. The numbers still rank the suggestions in that case - they just "
         "are not presented as shared history.")

    # ── Page 4 ───────────────────────────────────────────────────────────────
    p.add_page()
    h2(p, "Files")
    kv_table(p, [
        ("backend/liquor_prices.py",
         "The price table, its sources, and the cross-region lookups. Pure data plus small helpers "
         "- no database, no framework."),
        ("backend/routers/recommend.py",
         "Two endpoints. GET /recommend/meta lists the states we have prices for; GET /recommend/ "
         "does the work. Holds the history scan, the bottle solver and the ranking."),
        ("frontend/src/pages/Recommend.jsx",
         "The form and the result cards, including the three-region price strip."),
        ("frontend/src/components/BottomNav.jsx",
         "The raised centre key routes here."),
    ], w1=58)

    h2(p, "Known limits")
    bullet(p, "Uttar Pradesh coverage is thin - 8 brands - because UP publishes PDFs rather than "
              "anything machine-readable. Real shop prices would fix this fastest.")
    bullet(p, "Prices drift with every excise year, and shops vary within a state. These are "
              "indicative, which is what the source dates are for.")
    bullet(p, "Brand matching across regions is on name and size. A brand written differently by "
              "two sources will not match, and shows as a dash rather than a wrong price.")
    bullet(p, "The demand model - about a quarter-bottle a head - is a starting point, not "
              "science. The budget is the real control.")

    h2(p, "What it would take to add a state")
    body(p,
         "Add rows to liquor_prices.py with a real source, and it appears in the dropdown "
         "automatically. Nothing else changes: the solver, the comparison and the ranking are all "
         "driven off the table. If a state should join the NCR comparison, add it to the NCR tuple.")

    p.output(str(OUT))
    return OUT


if __name__ == "__main__":
    path = build()
    print(f"wrote {path}  ({path.stat().st_size:,} bytes)")
