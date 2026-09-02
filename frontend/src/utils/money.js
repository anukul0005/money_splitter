// One definition of "settled", shared by every screen that shows a balance.

/**
 * Balances below this are treated as settled.
 *
 * Amounts are displayed to the rupee, so a threshold of one paisa could mark
 * someone unsettled over a balance that renders as "₹0" — which is exactly
 * what a ₹0.35 residue against Utkarsh did. That residue isn't a debt anyone
 * can pay; it's what's left when percentage and equal splits don't divide
 * evenly, and it accumulates across groups that individually look clean.
 *
 * A rupee is the smallest amount this app can show, so it's the smallest
 * amount it should ask anyone to settle.
 */
export const SETTLED_BELOW = 1

export const isSettled = (net) => Math.abs(Number(net) || 0) < SETTLED_BELOW

/** Is this balance worth counting toward a total? */
export const owes = (net) => Number(net) <= -SETTLED_BELOW
export const owed = (net) => Number(net) >= SETTLED_BELOW
