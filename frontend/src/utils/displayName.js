// Usernames ("Ajay1969") are for signing in and for keying groups, expenses
// and balances - never what people read. dn() turns one into what the
// person is called: the first word of their full name ("Ajay Kumar" ->
// "Ajay"), or the name itself for anyone without one, including people who
// aren't on the app at all (a group member typed in as "Reetu").
//
// The directory (username -> full name) is loaded once by App from the user
// list and kept in localStorage so names show right from the first paint.

const KEY = 'splitter_names_v1'
const lc = (s) => (s || '').trim().toLowerCase()
const first = (s) => (s || '').trim().split(/\s+/)[0] || ''

let dir = new Map()
try { dir = new Map(JSON.parse(localStorage.getItem(KEY) || '[]')) } catch { /* private mode */ }

export function setDirectory(users) {
  dir = new Map((users || []).filter((u) => u?.name).map((u) => [lc(u.name), (u.full_name || '').trim()]))
  try { localStorage.setItem(KEY, JSON.stringify([...dir])) } catch { /* private mode */ }
}

/**
 * What to call `name`. Pass `among` - everyone else shown alongside (a
 * group's members) - and when two of them would both read "Ajay", the full
 * name is used instead so they can still be told apart.
 */
export function dn(name, among) {
  if (!name) return name
  const full = dir.get(lc(name))
  if (!full) return name
  const short = first(full)
  if (among?.length) {
    const clash = among.some((o) => lc(o) !== lc(name)
      && (lc(o) === lc(short) || lc(first(dir.get(lc(o)))) === lc(short)))
    if (clash) return full
  }
  return short
}

/** dn() for each of a list, told apart against each other. */
export const dnList = (names) => (names || []).map((n) => dn(n, names))
