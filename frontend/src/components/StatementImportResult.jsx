/**
 * What a statement import did, from POST /expenses/import-statement's
 * response: how many were added or merged, and every payment left out with
 * why - so a wrong call is visible rather than an amount silently missing.
 * Shared by Add Expense and the monthly page's Upload button.
 */
export default function StatementImportResult({ result: csvResult }) {
  return (
    <div className="text-xs text-brand-700 mt-2 space-y-0.5">
      <p className="font-bold">✓ {csvResult.source ? `${csvResult.source} statement` : 'Statement'} imported into your monthly groups</p>
      <p>{csvResult.created} added · {csvResult.merged} merged with existing entries</p>
      <p className="text-gray-500">
        {csvResult.linked_to_shared?.length ?? 0} already in shared groups
        {` · ${csvResult.skipped_as_transfers?.length ?? 0} settle-ups/loans`}
        {csvResult.skipped_investments?.length > 0 &&
          ` · ${csvResult.skipped_investments.length} investments (₹${csvResult.skipped_investments
            .reduce((s, x) => s + x.amount, 0).toLocaleString('en-IN')})`}
        {csvResult.skipped_self_transfers?.length > 0 &&
          ` · ${csvResult.skipped_self_transfers.length} transfers to your own accounts`}
        {csvResult.skipped_excluded_payees?.length > 0 &&
          ` · ${csvResult.skipped_excluded_payees.length} to excluded friends`}
        {csvResult.skipped_credit_repayments?.length > 0 &&
          ` · ${csvResult.skipped_credit_repayments.length} credit repayments (₹${csvResult.skipped_credit_repayments
            .reduce((s, x) => s + x.amount, 0).toLocaleString('en-IN')})`}
        {csvResult.skipped_already_imported > 0 && ` · ${csvResult.skipped_already_imported} already imported`}
        {` · ${csvResult.credits_ignored} received payments ignored`}
      </p>
      {/* Every payment not added is listed with what it matched,
          so a wrong pairing is visible instead of silently lost. */}
      {[...(csvResult.linked_to_shared ?? []), ...(csvResult.skipped_as_transfers ?? [])].length > 0 && (
        <details className="text-gray-600">
          <summary className="cursor-pointer">Not added (matched to existing entries)</summary>
          <ul className="mt-1 space-y-0.5">
            {[...(csvResult.linked_to_shared ?? []), ...(csvResult.skipped_as_transfers ?? [])].map((x, i) => (
              <li key={i}>
                {x.date} · {x.merchant} ₹{x.amount.toLocaleString('en-IN')} → {x.matched}
              </li>
            ))}
          </ul>
        </details>
      )}
      {/* P2P, gambling and the like, each with who decided and
          why - the LLM's calls included, so a wrong one is
          visible and can be corrected. */}
      {csvResult.skipped_not_spending?.length > 0 && (
        <details className="text-gray-600">
          <summary className="cursor-pointer">
            Not counted as spending ({csvResult.skipped_not_spending.length}, ₹{csvResult.skipped_not_spending
              .reduce((s, x) => s + x.amount, 0).toLocaleString('en-IN')})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {csvResult.skipped_not_spending.map((x, i) => (
              <li key={i}>
                {x.date} · {x.merchant} ₹{x.amount.toLocaleString('en-IN')} → {x.reason}
                {x.by === 'llm' && <span className="text-gray-400"> (AI)</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {csvResult.llm?.error && csvResult.llm.asked > 0 && (
        <p className="text-amber-700">
          AI categorising was unavailable for {csvResult.llm.asked} new payee{csvResult.llm.asked > 1 ? 's' : ''}, so the built-in rules were used.
        </p>
      )}
      {csvResult.groups_created?.length > 0 && (
        <p className="text-gray-500">New groups: {csvResult.groups_created.join(', ')}</p>
      )}
    </div>
  )
}
