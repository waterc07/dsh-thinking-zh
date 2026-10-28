async (page) => {
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-variant="think"]')).map((row, index) => {
    const sep = row.querySelector('[data-shimmer-decoration]')
    const summary = sep ? sep.nextElementSibling : null
    const rect = row.getBoundingClientRect()
    const srect = summary ? summary.getBoundingClientRect() : null
    return {
      index,
      expanded: row.hasAttribute('data-expanded'),
      innerLen: String(row.innerText ?? '').length,
      preview: summary ? String(summary.textContent ?? '').trim().slice(0, 80) : null,
      title: summary ? String(summary.getAttribute('title') ?? '').slice(0, 80) : null,
      y: Math.round(rect.y), h: Math.round(rect.height), sy: srect ? Math.round(srect.y) : null, sh: srect ? Math.round(srect.height) : null,
      visible: srect ? (srect.y > 0 && srect.y < 700) : false,
    }
  }))
  const target = rows.find((row) => row.visible && row.preview)
  let shot = null
  if (target) {
    const row = page.locator('[data-variant="think"]').nth(target.index)
    const box = await row.boundingBox()
    if (box) {
      await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview.png', clip: { x: Math.max(0, box.x - 10), y: Math.max(0, box.y - 10), width: Math.min(1280, box.width + 20), height: Math.min(220, box.height + 20) } })
      shot = { x: box.x, y: box.y, w: box.width, h: box.height }
    }
  }
  return JSON.stringify({ rows, target, shot })
}
