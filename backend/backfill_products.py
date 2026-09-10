"""One-time load: the consolidated alcohol catalogue into products and
product_prices.

Run manually, not on every deploy - this reads a static Excel snapshot
(Alcohol_Prices_Final_Rated.xlsx), not something that changes per request.
Re-running it replaces every row: Product is keyed on canonical_name
(unique), and ProductPrice has a unique constraint on
(product_id, state, size_ml), so this is safe to run again after a refreshed
spreadsheet without piling up duplicates - existing rows are updated in
place, not doubled.

    python backfill_products.py [path-to-xlsx]

Defaults to the workbook this repo's own enrichment work produced, one
level up from backend/.
"""
import sys
from pathlib import Path

from openpyxl import load_workbook

from database import create_tables, get_session_factory
from liquor_prices import BOTTLES, SOURCES
from models import Product, ProductPrice

DEFAULT_XLSX = Path(__file__).resolve().parent.parent / "Alcohol_Prices_Final_Rated.xlsx"

PRODUCT_COLS = {
    "canonical_name": "Canonical Brand", "brand": "Canonical Brand",
    "category": "Category", "style": "Primary Style", "body": "Body",
    "abv": "ABV", "tasting_notes": "Tasting Notes",
    "rating": "Final Rating (0-5)", "rating_type": "Rating Type",
    "rating_basis": "Rating Basis", "rating_source": "Rating Source",
    "rating_url": "Rating URL",
    "sweetness": "Sweetness (1-5)", "smokiness": "Smokiness (1-5)",
    "smoothness": "Smoothness (1-5)", "spice": "Spice (1-5)",
    "fruit_citrus": "Fruit/Citrus (1-5)", "oak": "Oak/Wood (1-5)",
    "intensity": "Intensity (1-5)", "beginner_friendly": "Beginner Friendly (1-5)",
    "sipping_score": "Sipping Suitability (1-5)", "mixer_score": "Mixer Suitability (1-5)",
    "recommendation_tags": "Recommendation Tags", "rag_text": "RAG Text",
}


def _clean(v):
    return v if v not in ("", None) else None


def main():
    xlsx_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx_path.exists():
        raise SystemExit(f"Workbook not found: {xlsx_path}")

    create_tables()
    db = get_session_factory()()

    wb = load_workbook(xlsx_path, data_only=True)
    ws = wb["Product Master"]
    hdr = [c.value for c in ws[1]]
    rows = [dict(zip(hdr, r)) for r in ws.iter_rows(min_row=2, values_only=True)]

    by_name: dict[str, Product] = {p.canonical_name: p for p in db.query(Product).all()}
    for r in rows:
        name = r["Canonical Brand"]
        if not name:
            continue
        product = by_name.get(name)
        if product is None:
            product = Product(canonical_name=name)
            db.add(product)
            by_name[name] = product
        for field, col in PRODUCT_COLS.items():
            setattr(product, field, _clean(r.get(col)))
    db.commit()
    print(f"Products: {len(by_name)}")

    # One row per (product, state, size) that BOTTLES already carries -
    # the exact-brand-string join validated during the Excel consolidation
    # (every price row's brand matched a Product Master row for every state
    # checked), same key used here.
    existing = {
        (pp.product_id, pp.state, pp.size_ml): pp
        for pp in db.query(ProductPrice).all()
    }
    written = 0
    skipped: list[str] = []
    for b in BOTTLES:
        product = by_name.get(b.brand)
        if product is None:
            skipped.append(b.brand)
            continue
        key = (product.id, b.state, b.size_ml)
        pp = existing.get(key)
        if pp is None:
            pp = ProductPrice(product_id=product.id, state=b.state, size_ml=b.size_ml)
            db.add(pp)
            existing[key] = pp
        pp.price = b.price
        pp.price_max = b.price_max
        pp.source = b.source
        pp.source_url = SOURCES.get(b.source, {}).get("url")
        pp.checked_on = SOURCES.get(b.source, {}).get("as_of")
        written += 1
    db.commit()
    print(f"Prices: {written}")
    if skipped:
        print(f"Skipped {len(skipped)} price rows with no matching product "
             f"(brand string not in Product Master): {sorted(set(skipped))[:10]}"
             f"{' ...' if len(set(skipped)) > 10 else ''}")


if __name__ == "__main__":
    main()
