async (page) => {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('[data-step-process]'))
    const target = candidates.find((el) => /已完成|用时/.test(String(el.textContent ?? '')))
    if (!target) return { found: false, count: candidates.length }
    const header = target.querySelector('[data-disclosure-row]') ?? target
    header.click()
    return { found: true, text: String(target.textContent ?? '').slice(0, 60) }
  })
  await page.waitForTimeout(1200)
  const state = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const first = rows[0]
    let el = first
    while (el && el !== document.body) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(`${style.overflowY}`) && el.scrollHeight > el.clientHeight + 10) break
      el = el.parentElement
    }
    if (el && el !== document.body) {
      const rect = first.getBoundingClientRect()
      const containerRect = el.getBoundingClientRect()
      el.scrollTop += rect.top - containerRect.top - 120
    }
    return {
      expanded: document.querySelectorAll('[data-variant="think"][data-expanded]').length,
      firstInnerText: String(first.innerText ?? '').slice(0, 100),
      firstY: Math.round(first.getBoundingClientRect().y),
      stepExpanded: document.querySelectorAll('[data-step-process][data-expanded]').length,
    }
  })
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview.png' })
  return JSON.stringify({ clicked, state })
}
