async (page) => {
  const collapsedNow = await page.evaluate(() => {
    let count = 0
    for (const row of document.querySelectorAll('[data-variant="think"][data-expanded]')) {
      const header = row.querySelector('[data-disclosure-row]')
      if (header) { header.click(); count += 1 }
    }
    return count
  })
  await page.waitForTimeout(1200)
  const result = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const expanded = document.querySelectorAll('[data-variant="think"][data-expanded]').length
    let el = rows[0]
    while (el && el !== document.body) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(`${style.overflowY}`) && el.scrollHeight > el.clientHeight + 10) break
      el = el.parentElement
    }
    if (el && el !== document.body) el.scrollTop = 0
    return { collapsedClicked: expanded === 0 ? "none-left" : "still-expanded", expanded, rows: rows.length, container: el ? el.className.slice(0, 60) : null }
  })
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview.png' })
  const visible = await page.evaluate(() => Array.from(document.querySelectorAll('[data-variant="think"]')).slice(0, 3).map((row) => {
    const sep = row.querySelector('[data-shimmer-decoration]')
    const summary = sep ? sep.nextElementSibling : null
    const rect = summary ? summary.getBoundingClientRect() : null
    return { text: summary ? String(summary.textContent ?? '').trim().slice(0, 60) : null, title: summary ? String(summary.getAttribute('title') ?? '').slice(0, 60) : null, y: rect ? Math.round(rect.y) : null, expanded: row.hasAttribute('data-expanded') }
  }))
  return JSON.stringify({ collapsedNow, result, visible })
}
