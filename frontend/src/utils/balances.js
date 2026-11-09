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
      // One brief line: the loan's own note, else what it was
      about: l.note || `${iOwe ? 'Borrowed' : 'Lent'} ₹${Number(l.principal).toLocaleString('en-IN')}${l.start_date ? ` on ${l.start_date}` : ''}`,
      // EMIs still open (unpaid ones, each with its date and what's left of it), or the one due date
      emis: (l.installments || []).filter((i) => !i.paid && i.balance > 0.01), dueDate: l.due_date,
    })
  }

  // A bill share's dates: billed on the bill's day of that month, due by its
  // due day (the next month's when that comes before the billing day)
  const billDates = (b, open) => {
    const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    return open.map((c) => {
      const [y, m] = c.period.split('-').map(Number)
      const billed = iso(y, m, b.day_of_month || 1)
      let due = null
      if (b.due_day) {
        const next = b.due_day < (b.day_of_month || 1)
        due = next ? iso(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, b.due_day) : iso(y, m, b.due_day)
      }
      return { period: c.period, billed, due, amount: c.due ?? c.share }
    }).sort((a, b2) => (a.period < b2.period ? -1 : 1))
  }

  for (const b of loansData?.bills ?? []) {
    const item = (open, positive) => {
      const due = open.reduce((s, c) => s + (c.due ?? c.share), 0)
      return [due, { key: `bill${b.id}`, tag: 'Bill', label: b.title, amount: due, positive,
                     billDay: b.day_of_month, dueDay: b.due_day, months: billDates(b, open) }]
    }
    if (same(b.payer, me)) {
      const debtors = [...new Set(b.charges.map((c) => c.member))]
      for (const m of debtors) {
        const [due, it] = item(b.charges.filter((c) => same(c.member, m) && !c.paid), true)
        if (due > 0.01) add(m, due, it)
      }
    } else {
      const [due, it] = item(b.charges.filter((c) => same(c.member, me) && !c.paid), false)
      if (due > 0.01) add(b.payer, -due, it)
    }
  }
  return byPerson
}

/** [{ name, net, groups, loanItems }] - one row per person, groups + loans
 *  + bills netted together. net > 0: they owe you; net < 0: you owe them. */
export function combinedBalances(friends, loansData, me) {
  const rows = {}
  for (const f of friends ?? []) {
    // groups: each group's amount from its expenses alone (the history);
    // liveGroups: what's still owed in each after payments (the breakdown
    // of `net` as it stands).
    rows[key(f.name)] = { name: f.name, net: f.net ?? 0, groups: f.groups ?? [],
                          liveGroups: f.live_groups ?? f.groups ?? [], loanItems: [] }
  }
  for (const [k, l] of Object.entries(loanContributions(loansData, me))) {
    const row = rows[k] || { name: l.name, net: 0, groups: [], liveGroups: [], loanItems: [] }
    row.net += l.net
    row.loanItems = l.items
    rows[k] = row
  }
  return Object.values(rows)
}
