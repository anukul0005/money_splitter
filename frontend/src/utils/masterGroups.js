// Consolidates groups (or per-group balances) that share the exact same
// 2-person membership into a single "master group" for display purposes.
// Sub-groups themselves are never modified — this is purely a view-layer grouping.

export function initialsOf(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?'
}

export function pairKey(names) {
  return names.map((n) => n.trim().toLowerCase()).sort().join('|')
}

export function pairLabel(names) {
  return names.map(initialsOf).sort().join(' & ')
}

// groups: array of GroupSummary-like objects with { id, member_names, total_amount, ... }
export function buildMasterGroups(groups) {
  const byPair = new Map()
  for (const g of groups) {
    const names = g.member_names ?? []
    if (names.length !== 2) continue
    const key = pairKey(names)
    if (!byPair.has(key)) byPair.set(key, { key, names, groups: [] })
    byPair.get(key).groups.push(g)
  }

  const masters = []
  const consolidatedIds = new Set()
  for (const entry of byPair.values()) {
    if (entry.groups.length >= 2) {
      masters.push({
        key: entry.key,
        label: pairLabel(entry.names),
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

// entries: array of balance-summary objects with { group_id, net, ... }
// groupsById: Map of group_id -> GroupSummary (for member_names lookup)
export function buildMasterBalances(entries, groupsById) {
  const byPair = new Map()
  for (const e of entries) {
    const g = groupsById.get(e.group_id)
    const names = g?.member_names ?? []
    if (names.length !== 2) continue
    const key = pairKey(names)
    if (!byPair.has(key)) byPair.set(key, { key, names, items: [] })
    byPair.get(key).items.push(e)
  }

  const masters = []
  const consolidatedIds = new Set()
  for (const entry of byPair.values()) {
    if (entry.items.length >= 2) {
      masters.push({
        key: entry.key,
        label: pairLabel(entry.names),
        names: entry.names,
        items: entry.items,
        net: entry.items.reduce((s, i) => s + i.net, 0),
      })
      entry.items.forEach((i) => consolidatedIds.add(i.group_id))
    }
  }

  const solo = entries.filter((e) => !consolidatedIds.has(e.group_id))
  return { masters, solo }
}
