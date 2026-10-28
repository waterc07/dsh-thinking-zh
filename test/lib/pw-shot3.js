async (page) => {
  await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview.png' })
  return JSON.stringify(await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const visible = rows.map((row, index) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      const summary = sep ? sep.nextElementSibling : null
      const rect = row.getBoundingClientRect()
      return { index, y: Math.round(rect.y), preview: summary ? String(summary.textContent ?? '').trim().slice(0, 40) : null, title: summary ? String(summary.getAttribute('title') ?? '').slice(0, 40) : null }
    }).filter((row) => row.y > 40 && row.y < 700)
    return { visible }
  }))
}
