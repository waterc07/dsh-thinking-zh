async (page) => {
  const before = await page.evaluate(() => ({
    expanded: document.querySelectorAll('[data-variant="think"][data-expanded]').length,
    aria: document.querySelector('[data-variant="think"] [data-disclosure-row]')?.getAttribute('aria-expanded'),
  }))
  await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"] [data-disclosure-row]')
    if (row) row.click()
  })
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => ({
    expanded: document.querySelectorAll('[data-variant="think"][data-expanded]').length,
    aria: document.querySelector('[data-variant="think"] [data-disclosure-row]')?.getAttribute('aria-expanded'),
    bodyLen: (() => { const row = document.querySelector('[data-variant="think"][data-expanded]'); return row ? String(row.innerText).length : -1 })(),
    bodySample: (() => { const row = document.querySelector('[data-variant="think"][data-expanded]'); const body = row?.querySelector('[class*="thinkBody"]'); return body ? String(body.innerText).slice(0, 200) : null })(),
  }))
  return JSON.stringify({ before, after })
}
