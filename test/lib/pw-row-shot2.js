async (page) => {
  // Collapse any expanded reasoning row.
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('[data-variant="think"][data-expanded]')) {
      const header = row.querySelector('[data-disclosure-row]')
      if (header) header.click()
    }
  })
  await page.waitForTimeout(900)
  const scrolled = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const target = rows[1]
    if (!target) return { ok: false }
    let el = target.parentElement
    while (el && el !== document.body) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(`${style.overflowY}`) && el.scrollHeight > el.clientHeight + 20) break
      el = el.parentElement
    }
    if (!el || el === document.body) return { ok: false, reason: 'no scroller' }
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top - 180
    el.scrollTop += delta
    return { ok: true, scrollTop: Math.round(el.scrollTop), delta: Math.round(delta), cls: String(el.className).slice(0, 40) }
  })
  await page.waitForTimeout(900)
  const info = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const target = rows[1]
    const sep = target.querySelector('[data-shimmer-decoration]')
    const summary = sep ? sep.nextElementSibling : null
    const rect = target.getBoundingClientRect()
    return {
      y: Math.round(rect.y), h: Math.round(rect.height),
      preview: summary ? String(summary.textContent ?? '').trim() : null,
      title: summary ? String(summary.getAttribute('title') ?? '') : null,
      expandedCount: document.querySelectorAll('[data-variant="think"][data-expanded]').length,
    }
  })
  const box = await page.locator('[data-variant="think"]').nth(1).boundingBox()
  let shot = null
  if (box && box.y >= 0 && box.y < 700) {
    const y = Math.max(0, box.y - 30)
    await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview.png', clip: { x: Math.max(0, box.x - 20), y, width: Math.min(1280 - Math.max(0, box.x - 20), box.width + 40), height: Math.min(200, 720 - y) } })
    shot = { x: box.x, y: box.y, w: box.width, h: box.height }
  }
  return JSON.stringify({ scrolled, info, shot })
}
