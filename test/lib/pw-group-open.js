async (page) => {
  const info = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[data-step-process]'))
    const targets = groups.map((group) => {
      const button = group.querySelector('button[data-process-activity]')
      return { text: String(button?.textContent ?? '').slice(0, 40), expanded: button?.getAttribute('aria-expanded') }
    })
    const group = groups.find((g) => /已完成/.test(String(g.textContent ?? '')))
    const button = group ? group.querySelector('button[data-process-activity]') : null
    if (button) button.click()
    return { groups: targets.length, sample: targets.slice(0, 4), clicked: button !== null }
  })
  await page.waitForTimeout(1500)
  const state = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const first = rows[0]
    if (!first) return { rows: 0 }
    const sep = first.querySelector('[data-shimmer-decoration]')
    const summary = sep ? sep.nextElementSibling : null
    const rect = first.getBoundingClientRect()
    return {
      rows: rows.length,
      expandedThink: document.querySelectorAll('[data-variant="think"][data-expanded]').length,
      innerText: String(first.innerText ?? '').slice(0, 120),
      previewText: summary ? String(summary.textContent ?? '').trim().slice(0, 120) : null,
      title: summary ? String(summary.getAttribute('title') ?? '').slice(0, 120) : null,
      rect: { y: Math.round(rect.y), h: Math.round(rect.height) },
    }
  })
  await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview.png' })
  return JSON.stringify({ info, state })
}
