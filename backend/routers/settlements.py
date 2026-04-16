from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Group
from schemas import SettlementOut, BalanceEntry, Transaction

router = APIRouter(prefix="/settlements", tags=["settlements"])


def _calculate(group: Group) -> SettlementOut:
    member_names = [m.name for m in group.members]
    if not member_names:
        return SettlementOut(group_id=group.id, balances=[], transactions=[])

    paid: dict[str, float] = {m: 0.0 for m in member_names}
    share: dict[str, float] = {m: 0.0 for m in member_names}

    for exp in group.expenses:
        payer = exp.paid_by
        amount = exp.amount
        divider = exp.divider or len(member_names)
        individual = exp.individual_amount or round(amount / divider, 2)

        # Determine participants for this expense
        if exp.participants:
            participants = [p.strip() for p in exp.participants.split(",")]
        else:
            # Use first `divider` members — keeps historical data consistent
            participants = member_names[:divider]

        if payer in paid:
            paid[payer] += amount

        for p in participants:
            if p in share:
                share[p] += individual

    balances: list[BalanceEntry] = []
    net_map: dict[str, float] = {}

    for m in member_names:
        net = round(paid[m] - share[m], 2)
        net_map[m] = net
        balances.append(BalanceEntry(
            member=m,
            paid=round(paid[m], 2),
            share=round(share[m], 2),
            net=net,
        ))

    # Minimize transactions using greedy creditor-debtor matching
    creditors = sorted([(n, v) for n, v in net_map.items() if v > 0.01], key=lambda x: -x[1])
    debtors = sorted([(n, -v) for n, v in net_map.items() if v < -0.01], key=lambda x: -x[1])

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

    return SettlementOut(group_id=group.id, balances=balances, transactions=transactions)


@router.get("/{group_id}", response_model=SettlementOut)
async def get_settlement(group_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Group).where(Group.id == group_id))
    group = result.scalar_one_or_none()
    if not group:
        raise HTTPException(404, "Group not found")
    return _calculate(group)
