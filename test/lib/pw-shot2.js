async (page) => {
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    let el = rows[0]
    while (el && el !== document.body) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(`${style.overflowY}`) && el.scrollHeight > el.clientHeight + 10) break
      el = el.parentElement
    }
    if (el && el !== document.body) el.scrollTop = 0
    const target = rows[0]
    if (target) {
      const rect = target.getBoundingClientRect()
      const containerRect = el.getBoundingClientRect()
      el.scrollTop += rect.top - containerRect.top - 120
    }
  })
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview2.png' })
  return JSON.stringify(await page.evaluate(() => ({
    expanded: document.querySelectorAll('[data-variant="think"][data-expanded]').length,
    y: Math.round(document.querySelector('[data-variant="think"]').getBoundingClientRect().y),
    text: String(document.querySelector('[data-variant="think"]').innerText ?? '').slice(0, 120),
  })))
}
