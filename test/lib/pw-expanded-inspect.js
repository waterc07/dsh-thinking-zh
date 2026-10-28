async (page) => {
  await page.screenshot({ path: 'test/evidence/e2e-expanded-row.png' })
  return JSON.stringify(await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"][data-expanded]')
    if (!row) return { found: false }
    const body = row.querySelector('[class*="thinkBody"]')
    return {
      found: true,
      rootAttrs: Array.from(row.attributes).map((a) => `${a.name}=${a.value}`).join(' | '),
      textContentLen: String(row.textContent ?? '').length,
      innerTextLen: String(row.innerText ?? '').length,
      bodyExists: body !== null,
      bodyTextContent: body === null ? null : String(body.textContent ?? '').slice(0, 400),
      bodyInnerText: body === null ? null : String(body.innerText ?? '').slice(0, 400),
      bodyHtml: body === null ? null : body.outerHTML.slice(0, 800),
      rowHtmlTail: row.outerHTML.slice(-1200),
    }
  }))
}
