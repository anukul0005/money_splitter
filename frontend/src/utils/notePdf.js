// A note as a PDF, made on the device (jsPDF, loaded only when asked for):
// its name and who it's with, the summary, the whole table with who added
// each row, and the link that opens it in the app.

// jsPDF's built-in font has no ₹ (or other non-Latin letters)
const clean = (t) => String(t ?? '').replace(/₹/g, 'Rs ').replace(/[​]/g, '')

const num = (c) => {
  const m = String(c || '').replace(/[₹,\s]/g, '').match(/^-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}
const fmt = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })

export async function downloadNotePdf(note, rows, { me, link }) {
  const [{ jsPDF }, at] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = [at.default, at.autoTable, at.default?.default, at.default?.autoTable].find((f) => typeof f === 'function')
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: note.columns.length > 5 ? 'landscape' : 'portrait' })
  const W = doc.internal.pageSize.getWidth()
  const M = 36
  const who = (n) => (n && n.toLowerCase() === (me || '').toLowerCase() ? `${n} (you)` : n || '')
  let y = M + 6

  doc.setFont('helvetica', 'bold'); doc.setFontSize(18)
  doc.splitTextToSize(clean(note.title), W - 2 * M).forEach((l) => { doc.text(l, M, y); y += 22 })

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100)
  const people = (note.people || []).map((p) => p.name + (p.on_app ? '' : ' (not on the app)'))
  const lines = [
    `Made by ${note.owner}${people.length ? ` · with ${people.join(', ')}` : ''}`,
    `${rows.length} row${rows.length === 1 ? '' : 's'} · downloaded ${new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
  ]
  lines.forEach((l) => { doc.splitTextToSize(clean(l), W - 2 * M).forEach((x) => { doc.text(x, M, y); y += 12 }) })

  // Summary: totals of number columns, and rows/totals per person who added them
  const numeric = note.columns.map((_, ci) => {
    const filled = rows.map((r) => r.cells[ci]).filter((c) => String(c || '').trim())
    return filled.length > 0 && filled.filter((c) => num(c) !== null).length >= filled.length * 0.6
  })
  const sums = (rs) => note.columns.map((_, ci) => (numeric[ci] ? rs.reduce((t, r) => t + (num(r.cells[ci]) || 0), 0) : null))
  const byWho = {}
  rows.forEach((r) => { (byWho[r.by || 'Unknown'] = byWho[r.by || 'Unknown'] || []).push(r) })
  const numCols = note.columns.filter((_, ci) => numeric[ci])
  y += 6
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Added by', 'Rows', ...numCols.map(clean)]],
    body: [
      ...Object.entries(byWho).sort((a, b) => b[1].length - a[1].length).map(([n, rs]) => {
        const s = sums(rs)
        return [clean(who(n)), rs.length, ...note.columns.flatMap((_, ci) => (numeric[ci] ? [fmt(s[ci])] : []))]
      }),
      ['Total', rows.length, ...sums(rows).filter((v) => v !== null).map(fmt)],
    ],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 4 },
    headStyles: { fillColor: [241, 245, 249], textColor: 40, fontStyle: 'bold' },
    didParseCell: (d) => { if (d.section === 'body' && d.row.index === Object.keys(byWho).length) d.cell.styles.fontStyle = 'bold' },
    tableWidth: Math.min(W - 2 * M, 120 + 70 * (numCols.length + 1)),
  })
  y = doc.lastAutoTable.finalY + 16

  // The whole table
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M, bottom: 40 },
    head: [['#', ...note.columns.map(clean), 'Added by']],
    body: rows.map((r, i) => [i + 1, ...note.columns.map((_, ci) => clean(r.cells[ci])), clean(who(r.by))]),
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 4, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 24, halign: 'right', textColor: 120 }, [note.columns.length + 1]: { cellWidth: 70, textColor: 100 } },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  })

  // The link, under the table and in every page's footer
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setFontSize(8); doc.setTextColor(120)
    doc.text(`Page ${p} of ${pages}`, W - M, doc.internal.pageSize.getHeight() - 18, { align: 'right' })
    doc.textWithLink('Open in Settle', M, doc.internal.pageSize.getHeight() - 18, { url: link })
  }
  doc.setPage(pages)
  let end = doc.lastAutoTable.finalY + 20
  if (end > doc.internal.pageSize.getHeight() - 60) { doc.addPage(); end = M + 10 }
  doc.setFontSize(9); doc.setTextColor(60)
  doc.text('Open this note in Settle (log in first):', M, end)
  doc.setTextColor(37, 99, 235)
  doc.textWithLink(link, M, end + 13, { url: link })

  const file = `${clean(note.title).replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-') || 'note'}.pdf`
  const blob = doc.output('blob')
  // Phones: the share sheet (Save to Files, WhatsApp...); else a download
  const asFile = typeof File !== 'undefined' ? new File([blob], file, { type: 'application/pdf' }) : null
  if (asFile && navigator.canShare?.({ files: [asFile] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [asFile], title: clean(note.title) }); return } catch (e) { if (e?.name === 'AbortError') return }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = file
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
