import json
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from models import Group
from schemas import SettlementOut, BalanceEntry, Transaction, PastPayment

router = APIRouter(prefix="/settlements", tags=["settlements"])


def _calculate(group: Group) -> SettlementOut:
    member_names = [m.name for m in group.members]
    if not member_names:
        return SettlementOut(group_id=group.id, balances=[], transactions=[], past_payments=[])

    paid: dict[str, float] = {m: 0.0 for m in member_names}
    share: dict[str, float] = {m: 0.0 for m in member_names}
    # settled_map[debtor][payer] = total settled so far
    settled_map: dict[str, dict[str, float]] = {m: {} for m in member_names}

    for exp in group.expenses:
        payer = exp.paid_by
        amount = exp.amount
        divider = exp.divider or len(member_names)
        individual = exp.individual_amount or round(amount / divider, 2)

        if exp.participants:
            participants = [p.strip() for p in exp.participants.split(",")]
        else:
            participants = member_names[:divider]

        if payer in paid:
            paid[payer] += amount

        settled_members: list[str] = json.loads(exp.settled_by) if exp.settled_by else []

        if exp.split_json:
            split_amounts = json.loads(exp.split_json)
            for p, amt in split_amounts.items():
                member_share = float(amt)
                if p in share:
                    share[p] += member_share
                if p in settled_members and p != payer and p in settled_map:
                    settled_map[p].setdefault(payer, 0.0)
                    settled_map[p][payer] += member_share
                    paid[p] += member_share  # treat as if debtor repaid their share
        else:
            for p in participants:
                if p in share:
                    share[p] += individual
                if p in settled_members and p != payer and p in settled_map:
                    settled_map[p].setdefault(payer, 0.0)
                    settled_map[p][payer] += individual
                    paid[p] += individual  # treat as if debtor repaid their share

    balances: list[BalanceEntry] = []
    net_map: dict[str, float] = {}

    for m in member_names:
        net = round(paid[m] - share[m], 2)
        net_map[m] = net
        balances.append(BalanceEntry(member=m, paid=round(paid[m], 2), share=round(share[m], 2), net=net))

    # Build past payments: pairs where debtor has already settled some amount to payer
    # Also track the original (pre-settle) debt to show total_owed
    past_payments: list[PastPayment] = []
    for debtor, payer_map in settled_map.items():
        for payer_name, settled_amt in payer_map.items():
            if settled_amt > 0.01:
                # original debt = current net (already adjusted) + settled_amt
                # net_map[debtor] = paid - share; since we added settled_amt to paid,
                # original_net = net_map[debtor] - settled_amt
                total_owed = round(settled_amt + max(0.0, -net_map[debtor]), 2)
                past_payments.append(PastPayment(
                    from_member=debtor,
                    to_member=payer_name,
                    settled_amount=round(settled_amt, 2),
                    total_owed=total_owed,
                ))

    creditors = sorted([(n, v) for n, v in net_map.items() if v > 0.01], key=lambda x: -x[1])
    debtors   = sorted([(n, -v) for n, v in net_map.items() if v < -0.01], key=lambda x: -x[1])

    cred = list(creditors)
    debt = list(debtors)
    transactions: list[Transaction] = []

    i = j = 0
    while i < len(cred) and j < len(debt):
        creditor, credit = cred[i]
        debtor, owed = debt[j]
        settle = min(credit, owed)
        transactions.append(Transaction(from_member=debtor, to_member=creditor, amount=round(settle, 2)))
        cred[i] = (creditor, round(credit - settle, 2))
        debt[j] = (debtor, round(owed - settle, 2))
        if cred[i][1] < 0.01:
            i += 1
        if debt[j][1] < 0.01:
            j += 1

    return SettlementOut(group_id=group.id, balances=balances, transactions=transactions, past_payments=past_payments)


@router.get("/{group_id}", response_model=SettlementOut)
def get_settlement(group_id: int, db: Session = Depends(get_db)):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(404, "Group not found")
    return _calculate(group)
