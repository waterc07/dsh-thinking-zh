async (page) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${String(error)}`))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`) })

  const read = () => page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const summaries = rows.map((row) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      return sep === null ? null : sep.nextElementSibling
    }).filter(Boolean)
    return {
      rows: rows.length,
      translated: summaries.filter((summary) => summary.hasAttribute('data-dsh-thinking-zh-original')).length,
      chinese: summaries.filter((summary) => /[\u4e00-\u9fff]/u.test(String(summary.textContent ?? ''))).length,
      expandedRows: document.querySelectorAll('[data-variant="think"][data-expanded]').length,
      translateCalls: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate')).length,
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
    }
  })

  const before = await read()

  // Expand through the React disclosure handler (the row is a role=button div).
  await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"] [data-disclosure-row]')
    if (row) row.click()
  })
  await page.waitForTimeout(1200)
  const expanded = await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"][data-expanded]')
    if (row === null) return { expanded: false }
    const body = row.querySelector('[class*="thinkBody"]')
    const sep = row.querySelector('[data-shimmer-decoration]')
    const summary = sep === null ? null : sep.nextElementSibling
    return {
      expanded: true,
      ariaExpanded: row.querySelector('[data-disclosure-row]')?.getAttribute('aria-expanded'),
      bodyChars: body === null ? 0 : String(body.textContent ?? '').length,
      bodyStartsWithEnglish: body !== null && /^[\s\S]{0,80}[A-Za-z]{3,}/u.test(String(body.textContent ?? '')),
      summaryTitle: summary === null ? null : String(summary.getAttribute('title') ?? '').slice(0, 120),
      summaryOriginal: summary === null ? null : String(summary.getAttribute('data-dsh-thinking-zh-original') ?? '').slice(0, 120),
      titleHasEnglish: summary !== null && /[A-Za-z]{4,}/u.test(String(summary.getAttribute('title') ?? '')),
      translatedWhileExpanded: summary !== null && summary.hasAttribute('data-dsh-thinking-zh-translation'),
    }
  })
  await page.screenshot({ path: 'test/evidence/e2e-expanded-row.png' })

  // Collapse again.
  await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"] [data-disclosure-row]')
    if (row) row.click()
  })
  await page.waitForTimeout(900)
  const collapsed = await read()

  // Scroll the transcript up and down.
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    if (rows.length > 0) rows[0].scrollIntoView({ block: 'center' })
  })
  await page.waitForTimeout(800)
  const afterScrollUp = await read()
  await page.evaluate(() => {
    const scroller = document.querySelector('[data-variant="think"]')
    if (scroller) scroller.scrollIntoView({ block: 'end' })
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(800)
  const afterScrollDown = await read()

  // Failure degradation: point the host at the 429-blocked google provider.
  const setProvider = async (provider) => page.evaluate(async (value) => {
    const response = await fetch('/api/dsh-thinking-zh/set', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: value }),
    })
    return { status: response.status, json: await response.json().catch(() => null) }
  }, provider)

  const providerGoogle = await setProvider('google')
  // A brand-new string exercises the failing provider.
  await page.getByRole('textbox', { name: /发消息|描述你想要构建/ }).fill(
    'Think in English. In one short sentence, define what an idempotent webhook is. No tools.',
  )
  await page.evaluate(() => { window.__failBase = document.querySelectorAll('[data-variant="think"]').length })
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.waitForFunction(() => document.querySelector('[data-streaming]') === null, undefined, { timeout: 240000 })
  await page.waitForTimeout(6000)
  const duringFailure = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const summaries = rows.map((row) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      return sep === null ? null : sep.nextElementSibling
    }).filter(Boolean)
    const last = summaries[summaries.length - 1]
    return {
      rows: rows.length,
      lastPreviewText: last === null ? null : String(last.textContent ?? '').trim().slice(0, 160),
      lastHasTranslation: last !== null && last.hasAttribute('data-dsh-thinking-zh-original'),
      translatedCount: summaries.filter((summary) => summary.hasAttribute('data-dsh-thinking-zh-original')).length,
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
    }
  })
  await page.screenshot({ path: 'test/evidence/e2e-provider-failure.png' })

  const providerBing = await setProvider('bing')
  // Reload: fresh client state retries the previously failed preview from the disk cache.
  await page.reload()
  await page.waitForSelector('[data-variant="think"]', { state: 'attached', timeout: 30000 })
  await page.waitForTimeout(6000)
  const afterRecovery = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const summaries = rows.map((row) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      return sep === null ? null : sep.nextElementSibling
    }).filter(Boolean)
    return {
      rows: rows.length,
      translatedCount: summaries.filter((summary) => summary.hasAttribute('data-dsh-thinking-zh-original')).length,
      chineseCount: summaries.filter((summary) => /[\u4e00-\u9fff]/u.test(String(summary.textContent ?? ''))).length,
      translateCalls: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate')).length,
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
      sessionTitle: document.title,
    }
  })
  await page.screenshot({ path: 'test/evidence/e2e-recovered.png' })

  return JSON.stringify({
    before,
    expanded,
    collapsed,
    afterScrollUp,
    afterScrollDown,
    translateCallsAdded: afterScrollDown.translateCalls - before.translateCalls,
    providerGoogle,
    duringFailure,
    providerBing,
    afterRecovery,
    errors,
  })
}
