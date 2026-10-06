// One per-person balance, used by both Home's headline and the Balances
// page that explains it - so the two can't disagree.
//
// Everything owed between you and someone is netted into ONE number before
// it's called "you owe" or "owed to you": every shared group (already
// netted per person by /stats/friends) plus every open loan and recurring
// bill share (/loans, which never passes through a group). Netting first
// matters - owing Anjali ₹8,372 on a loan while she owes you in a group is
// one smaller debt, not one entry in each column.

const key = (name) => (name || '').trim().toLowerCase()

/** Per-person contribution of open loans + unpaid bill shares. Keyed by
 *  lower-cased name; `name` keeps the first spelling seen. */
export function loanContributions(loansData, me) {
  const byPerson = {}
  const add = (name, signed, item) => {
    const k = key(name)
    const row = byPerson[k] || { name, net: 0, items: [] }
    row.net += signed
    row.items.push(item)
    byPerson[k] = row
  }
  const same = (a, b) => key(a) === key(b)

  for (const l of loansData?.loans ?? []) {
    if (l.total_due <= 0.01) continue
    const iOwe = same(l.borrower, me)
    const other = iOwe ? l.lender : l.borrower
    add(other, iOwe ? -l.total_due : l.total_due, {
      key: `loan${l.id}`, tag: 'Loan', label: iOwe ? `You owe ${other}` : `${other} owes you`,
      amount: l.total_due, positive: !iOwe,
    })
  }

  for (const b of loansData?.bills ?? []) {
    if (same(b.payer, me)) {
      const debtors = [...new Set(b.charges.map((c) => c.member))]
      for (const m of debtors) {
        const due = b.charges.filter((c) => same(c.member, m) && !c.paid).reduce((s, c) => s + c.share, 0)
        if (due > 0.01) add(m, due, { key: `bill${b.id}`, tag: 'Bill', label: b.title, amount: due, positive: true })
      }
    } else {
      const due = b.charges.filter((c) => same(c.member, me) && !c.paid).reduce((s, c) => s + c.share, 0)
      if (due > 0.01) add(b.payer, -due, { key: `bill${b.id}`, tag: 'Bill', label: b.title, amount: due, positive: false })
    }
  }
  return byPerson
}

/** [{ name, net, groups, loanItems }] - one row per person, groups + loans
 *  + bills netted together. net > 0: they owe you; net < 0: you owe them. */
export function combinedBalances(friends, loansData, me) {
  const rows = {}
  for (const f of friends ?? []) {
    rows[key(f.name)] = { name: f.name, net: f.net ?? 0, groups: f.groups ?? [], loanItems: [] }
  }
  for (const [k, l] of Object.entries(loanContributions(loansData, me))) {
    const row = rows[k] || { name: l.name, net: 0, groups: [], loanItems: [] }
    row.net += l.net
    row.loanItems = l.items
    rows[k] = row
  }
  return Object.values(rows)
}
