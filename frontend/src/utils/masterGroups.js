// Consolidates groups (or per-group balances) that share the exact same
// membership (any number of members) across multiple groups into a single
// "master group" for display purposes. Sub-groups themselves are never
// modified — this is purely a view-layer grouping.

export function pairKey(names) {
  return names.map((n) => n.trim().toLowerCase()).sort().join('|')
}

// Human-readable name list: "Anukul, Ajay" for 2, "Anukul, Anubhav & Ajay" for 3+.
export function nameList(names) {
  if (!names || names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return names.join(', ')
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

// A supergroup's name as the logged-in person sees it: everyone else, after
// "With" - "With Anjali", "With Utkarsh, Anjali & Nandini". A supergroup of just
// yourself (your own monthly tracking) keeps your name.
export function masterName(names, me) {
  const others = me ? names.filter((n) => n.trim().toLowerCase() !== me.trim().toLowerCase()) : names
  if (!me || others.length === names.length) return nameList(names)
  return others.length ? `With ${nameList(others)}` : nameList(names)
}

// groups: array of GroupSummary-like objects with { id, member_names, total_amount, ... }
// minGroups: minimum groups sharing a member set to form a master (default 2 —
// pass 1 to link every group to a master, even ones whose member set is unique).
// me: the logged-in user's name, for masterName.
export function buildMasterGroups(groups, minGroups = 2, me = null) {
  const byPair = new Map()
  for (const g of groups) {
    const names = g.member_names ?? []
    if (names.length < 1) continue
    const key = pairKey(names)
    if (!byPair.has(key)) byPair.set(key, { key, names, groups: [] })
    byPair.get(key).groups.push(g)
  }

  const masters = []
  const consolidatedIds = new Set()
  for (const entry of byPair.values()) {
    if (entry.groups.length >= minGroups) {
      masters.push({
        key: entry.key,
        name: masterName(entry.names, me),
        names: entry.names,
        groups: entry.groups,
        totalAmount: entry.groups.reduce((s, g) => s + (g.total_amount ?? 0), 0),
      })
      entry.groups.forEach((g) => consolidatedIds.add(g.id))
    }
  }

  const solo = groups.filter((g) => !consolidatedIds.has(g.id))
  return { masters, solo }
}
