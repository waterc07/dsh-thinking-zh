async (page) => {
  const focusRow = async (rowIndex) => page.evaluate((index) => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const row = rows[index]
    if (!row) return null
    let el = row
    while (el !== null && el !== document.body) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(`${style.overflowY}`) && el.scrollHeight > el.clientHeight + 10) break
      el = el.parentElement
    }
    if (el !== null && el !== document.body) {
      const rect = row.getBoundingClientRect()
      const containerRect = el.getBoundingClientRect()
      el.scrollTop += rect.top - containerRect.top - 80
    } else {
      row.scrollIntoView({ block: 'center', behavior: 'instant' })
    }
    return true
  }, rowIndex)

  // Collapse any expanded reasoning row first.
  await page.evaluate(() => {
    const expanded = document.querySelector('[data-variant="think"][data-expanded] [data-disclosure-row]')
    if (expanded) expanded.click()
  })
  await page.waitForTimeout(700)
  await focusRow(0)
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'test/evidence/e2e-collapsed-preview.png' })
  const collapsed = await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"]')
    const sep = row?.querySelector('[data-shimmer-decoration]')
    const summary = sep ? sep.nextElementSibling : null
    const rect = summary ? summary.getBoundingClientRect() : null
    return {
      text: summary ? String(summary.textContent ?? '').trim() : null,
      title: summary ? summary.getAttribute('title') : null,
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    }
  })

  // Expand the same row and screenshot the English body.
  await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"] [data-disclosure-row]')
    if (row) row.click()
  })
  await page.waitForTimeout(1200)
  await focusRow(0)
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'test/evidence/e2e-expanded-row.png' })
  const expanded = await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"][data-expanded]')
    const body = row ? row.querySelector('[class*="thinkBody"]') : null
    return {
      expanded: row !== null,
      bodyChars: body ? String(body.textContent ?? '').length : 0,
      bodyHead: body ? String(body.textContent ?? '').slice(0, 120) : null,
    }
  })

  return JSON.stringify({ collapsed, expanded })
}
