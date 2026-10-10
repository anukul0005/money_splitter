"""Step 2 of the spending dataset - transaction cleaning & categorisation.

    python ml_step2.py <user> <statement.csv> [<statement.csv> ...] [--out ../ml_data/step2]

Reads the PhonePe statements and the app's database (read-only), writes:

  transactions_clean.csv  one row per unique debit: txn_id, date, time,
                          amount, paid_to (as on the statement), merchant
                          (standardised), category, subcategory,
                          mapping_method, is_spending, exclusion_reason
  merchant_map.csv        paid_to_pattern -> merchant, category, subcategory,
                          mapping_method (+ how many transactions it covers)
  categories.csv          the category / subcategory list
  review_queue.csv        spending merchants nothing could place - for a
                          person to assign; never guessed
  validation_report.md    what was removed, what's missing, what to check

Manual review answers go in <out>/manual_mappings.csv (scope, key, category,
subcategory, note) and win over everything: scope "payee" with key = the
normalised paid_to applies to every transaction to that payee; scope "txn"
with key = a transaction id applies to that one. Category "NOT SPENDING"
takes the payment out of spending, with the subcategory as the reason.

Cleaning: duplicate transaction ids dropped (overlapping statements repeat
lines), rows with a missing id / payee / date / amount or an invalid date or
non-positive amount dropped and counted, credits dropped.

is_spending: the app's own decision - a debit whose transaction id is on an
expense the user paid (imported into a monthly group, merged with a
hand-entered one, or linked to a shared-group expense). Every other debit
gets the reason the import gave for leaving it out.

Categorising, per distinct payee (paid_to normalised: lower-case, letters
and digits only), first match wins:
  manual     the user's own answer (questionnaire / PayeeLabel source "user")
  brand      a known brand, every spelling of it (BRANDS below)
  label      an earlier LLM label - lower trust, listed in the report
  keyword    the controlled keyword rules in spend_categories
  rule       the user's rule: <= Rs 200 to a named person is a small vendor
and per transaction, for payees none of those place:
  app_entry  the category of the app expense the payment is linked to
Anything else is "Uncategorized" and goes to the review queue.
One mapping covers every transaction to that payee, past and future.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
from collections import Counter, defaultdict
from datetime import date

from sqlalchemy import func

from database import get_session_factory
from models import Expense, PayeeLabel, User
from routers.expenses import _norm, is_credit_repayment, is_investment
from spend_categories import TAXONOMY, _ANONYMOUS, _rule
from statement_import import is_self_transfer, own_accounts, parse_phonepe_csv

# Brand -> every spelling of it on a statement. Checked in order, so the
# more specific name comes first (Swiggy Instamart before Swiggy). Word
# boundaries matter: "ola" is also inside "GHOLAP TEA STALL".
BRANDS: list[tuple[str, str, str, str]] = [
    # (regex on the lower-cased payee, merchant, category, subcategory)
    (r"swiggy ?instamart|instamart", "Swiggy Instamart", "Groceries", "Quick commerce"),
    (r"swiggy ?diners|swiggy ?dineout", "Swiggy Dineout", "Food & Dining", "Restaurants"),
    (r"swiggy", "Swiggy", "Food & Dining", "Food delivery"),
    (r"zomato|eternal limited", "Zomato", "Food & Dining", "Food delivery"),
    (r"^district\b", "District (Zomato)", "Food & Dining", "Restaurants"),
    (r"blinkit|grofers", "Blinkit", "Groceries", "Quick commerce"),
    (r"zepto", "Zepto", "Groceries", "Quick commerce"),
    (r"bigbasket", "BigBasket", "Groceries", "Quick commerce"),
    (r"\buber\b", "Uber", "Transport", "Cab & auto"),
    (r"^ola$|\bola money\b|^olamoney", "Ola", "Transport", "Cab & auto"),
    (r"rapido|roppen", "Rapido", "Transport", "Cab & auto"),
    (r"irctc ?tourism", "IRCTC Tourism", "Travel", "Tours & bookings"),
    (r"irctc", "IRCTC", "Transport", "Train"),
    (r"amazon", "Amazon", "Shopping", "Online shopping"),
    (r"flipkart(?! pay later)", "Flipkart", "Shopping", "Online shopping"),
    (r"myntra", "Myntra", "Shopping", "Online shopping"),
    (r"jiocinema", "JioCinema", "Entertainment", "Subscriptions"),
    (r"\bjio\b|jio platforms", "Jio", "Bills & Utilities", "Mobile & internet"),
    (r"bharti airtel|^airtel$|www airtel", "Airtel", "Bills & Utilities", "Mobile & internet"),
    (r"bookmyshow", "BookMyShow", "Entertainment", "Movies & events"),
    (r"\bpvr\b", "PVR", "Entertainment", "Movies & events"),
    (r"dominos|jubilant food", "Domino's", "Food & Dining", "Food delivery"),
    (r"mcdonald|connaught plaza", "McDonald's", "Food & Dining", "Restaurants"),
    (r"\bkfc\b", "KFC", "Food & Dining", "Restaurants"),
    (r"haldiram", "Haldiram's", "Food & Dining", "Restaurants"),
    (r"airbnb", "Airbnb", "Travel", "Stays"),
    (r"\boyo\b", "OYO", "Travel", "Stays"),
    (r"decathlon", "Decathlon", "Shopping", "Sports"),
    (r"netflix", "Netflix", "Entertainment", "Subscriptions"),
    (r"spotify", "Spotify", "Entertainment", "Subscriptions"),
    (r"\bapple\b", "Apple", "Entertainment", "Subscriptions"),
    (r"dmrc|delhi metro", "Delhi Metro", "Transport", "Metro"),
]
_BRANDS = [(re.compile(p), m, c, s) for p, m, c, s in BRANDS]

# Legal and payment-gateway noise stripped to make a readable merchant name.
_NOISE = re.compile(r"\b(private|pvt|limited|ltd|llp|india|technologies|technology|services|payments?|"
                    r"retail|commerce|marketplace|media|enterprises?|rzp|razorpay|payu|co)\b\.?", re.I)


def brand_of(payee: str):
    t = payee.lower()
    for rx, m, c, s in _BRANDS:
        if rx.search(t):
            return m, c, s
    return None


def readable(payee: str) -> str:
    name = _NOISE.sub(" ", payee)
    name = re.sub(r"@.*$", "", name)            # UPI handle suffix
    name = re.sub(r"[^\w&' .-]", " ", name)
    name = re.sub(r"\s+", " ", name).strip(" .-")
    return name.title() if name else payee.strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("user")
    ap.add_argument("statements", nargs="+")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "ml_data", "step2"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    report: list[str] = ["# Step 2 - cleaning & categorisation", ""]

    # ── 1. Clean ──────────────────────────────────────────────────────────
    raw = []
    for path in args.statements:
        raw += [(t, os.path.basename(path)) for t in parse_phonepe_csv(open(path, "rb").read())]
    today = date.today().isoformat()
    seen, rows, drop = set(), [], Counter()
    for t, src in sorted(raw, key=lambda x: (x[0].date or "", x[0].time or "")):
        if not t.txn_id: drop["missing transaction id"] += 1; continue
        if t.txn_id in seen: drop["duplicate transaction id"] += 1; continue
        seen.add(t.txn_id)
        if not t.merchant or not t.merchant.strip(): drop["missing payee"] += 1; continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", t.date or "") or not ("2000-01-01" <= t.date <= today):
            drop["invalid date"] += 1; continue
        if t.amount is None or t.amount <= 0: drop["invalid amount"] += 1; continue
        if t.kind != "Debit": drop["credit (not a payment)"] += 1; continue
        rows.append(t)
    report += ["## 1. Cleaning", "", f"- statement lines read: {len(raw)} from {len(args.statements)} file(s)"]
    report += [f"- removed - {k}: {v}" for k, v in drop.most_common()]
    report += [f"- **kept: {len(rows)} unique debits**, {rows[0].date} to {rows[-1].date}", ""]

    # ── App state: what counts as spending, and why the rest doesn't ──────
    db = get_session_factory()()
    db.connection().exec_driver_sql("SET TRANSACTION READ ONLY")
    me = args.user.lower()
    user = db.query(User).filter(func.lower(User.name) == me).one()
    linked: dict[str, Expense] = {}
    for e in db.query(Expense).filter(Expense.txn_ref.isnot(None)):
        if (e.paid_by or "").lower() == me:
            for ref in e.txn_ref.split(","):
                linked[ref.strip()] = e
    labels = {l.payee_key: l for l in db.query(PayeeLabel).filter(func.lower(PayeeLabel.user_name) == me)}
    file_labels_path = os.path.join(os.path.dirname(__file__), "..", "ml_data", "payee_labels.json")
    file_labels = {k: v for k, v in json.load(open(file_labels_path, encoding="utf8")).items()
                   if not k.startswith("_")} if os.path.exists(file_labels_path) else {}
    try:
        excl = json.loads(user.excluded_payees or "[]")
    except ValueError:
        excl = []
    excluded_names = {_norm(x) for x in excl if not x.startswith("txn:")}
    excluded_txns = {x[4:] for x in excl if x.startswith("txn:")}
    own = own_accounts(rows)

    manual_payee, manual_txn = {}, {}
    mm_path = os.path.join(args.out, "manual_mappings.csv")
    if os.path.exists(mm_path):
        for m in csv.DictReader(open(mm_path, encoding="utf8")):
            if not m.get("category"):
                continue
            (manual_payee if m["scope"] == "payee" else manual_txn)[m["key"].strip()] = (m["category"], m.get("subcategory") or None)

    def exclusion(t) -> str:
        key = _norm(t.merchant)
        if is_investment(t.merchant): return "investment"
        if is_credit_repayment(t.merchant): return "credit/loan repayment"
        if is_self_transfer(t, own): return "transfer to own account"
        if key in excluded_names or t.txn_id in excluded_txns: return "excluded payee (P2P, gambling, asset)"
        lab = labels.get(key)
        if lab and lab.decision != "spending": return lab.decision.replace("_", " ")
        return "not spending (settle-up, P2P or one-off to a person)"

    # ── 2-5. Standardise merchants & map them ─────────────────────────────
    by_key: dict[str, list] = defaultdict(list)
    for t in rows:
        by_key[_norm(t.merchant)].append(t)

    def mapping_for(key: str, ts: list):
        name = Counter(t.merchant for t in ts).most_common(1)[0][0]
        b = brand_of(name)
        lab, fl = labels.get(key), file_labels.get(key)
        if key in manual_payee:
            return (key, b[0] if b else readable(name), *manual_payee[key], "manual")
        if lab and lab.source == "user" and lab.decision == "spending" and lab.category:
            return key, readable(name), lab.category, lab.subcategory, "manual"
        if fl and fl[2] == "user":
            return key, readable(name), fl[0], fl[1], "manual"
        if b:
            # pattern = the brand's regex, so every spelling maps the same way
            rx = next(p for p, m, *_ in BRANDS if m == b[0])
            return rx, b[0], b[1], b[2], "brand"
        if lab and lab.decision == "spending" and lab.category in TAXONOMY:
            return key, readable(name), lab.category, lab.subcategory, "label"
        if fl and fl[0] in TAXONOMY:
            return key, readable(name), fl[0], fl[1], "label"
        hit = _rule(name)
        if hit:
            return key, readable(name), hit[0], hit[1], "keyword"
        return key, readable(name), None, None, None

    mapping: dict[str, tuple] = {k: mapping_for(k, ts) for k, ts in by_key.items()}

    out_rows, unplaced = [], defaultdict(list)
    for t in rows:
        key = _norm(t.merchant)
        pattern, merchant, cat, sub, method = mapping[key]
        spending = t.txn_id in linked
        reason = ""
        # A manual answer for this payee or this transaction wins outright.
        override = manual_txn.get(t.txn_id) or (manual_payee.get(key) if spending else None)
        if override and override[0] == "NOT SPENDING":
            spending, reason = False, f"manual: {override[1] or 'not spending'}"
            cat = sub = None; method = "manual"
        elif override:
            cat, sub, method = override[0], override[1], "manual"
        if spending and not cat:
            e = linked[t.txn_id]
            if e.category in TAXONOMY:
                cat, sub, method = e.category, e.subcategory, "app_entry"
            elif t.amount <= 200 and not _ANONYMOUS.search(t.merchant.strip()):
                cat, sub, method = "Small vendors", "Unspecified", "rule"
        if spending and not cat:
            cat, sub, method = "Uncategorized", None, "unmapped"
            unplaced[key].append((t, linked[t.txn_id]))
        out_rows.append({
            "txn_id": t.txn_id, "date": t.date, "time": t.time or "", "amount": f"{t.amount:.2f}",
            "paid_to": t.merchant, "merchant": merchant,
            "category": cat or "", "subcategory": sub or "", "mapping_method": method or "",
            "is_spending": int(spending), "exclusion_reason": "" if spending else (reason or exclusion(t)),
        })

    # ── write outputs ─────────────────────────────────────────────────────
    def write(name, fields, data):
        with open(os.path.join(args.out, name), "w", newline="", encoding="utf8") as f:
            w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(data)

    write("transactions_clean.csv", list(out_rows[0]), out_rows)
    write("categories.csv", ["category", "subcategory"],
          [{"category": c, "subcategory": s} for c, subs in TAXONOMY.items() for s in subs])

    spend_rows = [r for r in out_rows if r["is_spending"]]
    agg = defaultdict(lambda: [0, 0.0])
    for r in spend_rows:
        k = (mapping[_norm(r["paid_to"])][0], r["merchant"], r["category"], r["subcategory"], r["mapping_method"])
        agg[k][0] += 1; agg[k][1] += float(r["amount"])
    write("merchant_map.csv", ["paid_to_pattern", "merchant", "category", "subcategory", "mapping_method", "n_txns", "total_amount"],
          [{"paid_to_pattern": k[0], "merchant": k[1], "category": k[2], "subcategory": k[3], "mapping_method": k[4],
            "n_txns": n, "total_amount": round(a, 2)} for k, (n, a) in sorted(agg.items(), key=lambda x: -x[1][1])])

    queue = []
    for key, items in sorted(unplaced.items(), key=lambda x: -sum(t.amount for t, _ in x[1])):
        queue.append({"paid_to_pattern": key, "paid_to": items[0][0].merchant, "n_txns": len(items),
                      "total_amount": round(sum(t.amount for t, _ in items), 2),
                      "dates": ", ".join(sorted({t.date for t, _ in items})[:5]),
                      "app_titles": " | ".join(sorted({(e.title or "").strip() for _, e in items if e.title})[:5]),
                      "category": "", "subcategory": ""})
    write("review_queue.csv", list(queue[0]) if queue else ["paid_to_pattern"], queue)

    # ── 6-8. Validate ─────────────────────────────────────────────────────
    total = sum(float(r["amount"]) for r in spend_rows)
    report += ["## 2. Spending vs not", "",
               f"- spending (on an app expense the user paid): {len(spend_rows)}, Rs {total:,.0f}",
               f"- not spending: {len(out_rows) - len(spend_rows)}"]
    for reason, n in Counter(r["exclusion_reason"] for r in out_rows if not r["is_spending"]).most_common():
        report.append(f"  - {reason}: {n}")
    report += ["", "## 3. How spending was categorised", "", "| method | txns | amount | share |", "|---|---:|---:|---:|"]
    for m, n in Counter(r["mapping_method"] for r in spend_rows).most_common():
        amt = sum(float(r["amount"]) for r in spend_rows if r["mapping_method"] == m)
        report.append(f"| {m} | {n} | Rs {amt:,.0f} | {amt / total * 100:.1f}% |")
    report += ["", f"Distinct payees (paid_to): {len(by_key)}; distinct merchants after standardising: "
               f"{len({r['merchant'] for r in out_rows})}", ""]

    report += ["## 4. Checks", ""]
    dups = len(out_rows) - len({r["txn_id"] for r in out_rows})
    report.append(f"- duplicate transaction ids in output: {dups}")
    for col in ("date", "amount", "paid_to", "merchant"):
        report.append(f"- missing {col}: {sum(1 for r in out_rows if not r[col])}")
    report.append(f"- spending rows without a category: {sum(1 for r in spend_rows if r['category'] in ('', 'Uncategorized'))} "
                  f"(Rs {sum(float(r['amount']) for r in spend_rows if r['category'] in ('', 'Uncategorized')):,.0f}) -> review_queue.csv")
    bad = [r for r in spend_rows if r["category"] not in TAXONOMY and r["category"] != "Uncategorized"]
    bad += [r for r in spend_rows if r["category"] in TAXONOMY and r["subcategory"] and r["subcategory"] not in TAXONOMY[r["category"]]]
    report.append(f"- categories/subcategories outside the list: {len(bad)}")
    # one merchant, several categories - a possible wrong mapping
    cats = defaultdict(set)
    for r in spend_rows:
        if r["mapping_method"] not in ("app_entry", "rule", "unmapped"):
            cats[r["merchant"]].add((r["category"], r["subcategory"]))
    conflicts = {m: c for m, c in cats.items() if len(c) > 1}
    report.append(f"- merchants mapped to more than one category: {len(conflicts)}")
    report += [f"  - {m}: " + "; ".join(f"{c} > {s}" for c, s in sorted(v)) for m, v in sorted(conflicts.items())]
    # keyword rules and earlier labels disagreeing - worth a look
    disagree = []
    for key, (pat, merchant, cat, sub, method) in mapping.items():
        if method == "label":   # a manual answer is the user's call already
            hit = _rule(by_key[key][0].merchant)
            if hit and hit[0] != cat:
                disagree.append(f"  - {merchant}: {method} says {cat} > {sub}, keyword rule says {hit[0]} > {hit[1]}")
    report.append(f"- payees where the keyword rules disagree with an earlier LLM label: {len(disagree)}")
    report += disagree[:40]
    # amounts far outside their subcategory's usual range
    by_sub = defaultdict(list)
    for r in spend_rows:
        by_sub[(r["category"], r["subcategory"])].append(float(r["amount"]))
    outliers = []
    for r in spend_rows:
        if r["mapping_method"] == "manual":
            continue                          # reviewed and confirmed
        xs = sorted(by_sub[(r["category"], r["subcategory"])])
        if len(xs) >= 10:
            med = xs[len(xs) // 2]
            if float(r["amount"]) > max(10 * med, 5000):
                outliers.append(f"  - {r['date']} Rs {float(r['amount']):,.0f} {r['paid_to']!r} as {r['category']} > {r['subcategory']} (usual ~Rs {med:,.0f})")
    report.append(f"- amounts over 10x their subcategory's median (possible wrong mapping): {len(outliers)}")
    report += outliers[:40]
    label_n = sum(1 for r in spend_rows if r["mapping_method"] == "label")
    report += ["", f"Note: {label_n} spending transactions rest on earlier LLM labels (mapping_method = label), "
               "not on a brand, keyword or your own answer - the lower-trust part of the mapping."]

    open(os.path.join(args.out, "validation_report.md"), "w", encoding="utf8").write("\n".join(report) + "\n")
    db.rollback(); db.close()
    print("\n".join(report))
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
