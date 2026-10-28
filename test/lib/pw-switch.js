async (page) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${String(error)}`))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`) })

  const firstTitle = await page.title()
  const base = await page.evaluate(() => ({
    translateCalls: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate')).length,
    rows: document.querySelectorAll('[data-variant="think"]').length,
  }))

  // Create a second lab session in the current (lab) workspace.
  await page.getByRole('button', { name: '新建会话' }).first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('textbox', { name: /发消息|描述你想要构建/ }).fill(
    'Think in English. Explain in one short paragraph why a translation overlay should keep the source sentence in a title attribute. No tools.',
  )
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-variant="think"]').length > 0 && document.querySelector('[data-streaming]') === null, undefined, { timeout: 240000 })
  await page.waitForTimeout(5000)
  const secondSession = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const summaries = rows.map((row) => { const sep = row.querySelector('[data-shimmer-decoration]'); return sep === null ? null : sep.nextElementSibling }).filter(Boolean)
    return {
      title: document.title,
      rows: rows.length,
      translated: summaries.filter((s) => s.hasAttribute('data-dsh-thinking-zh-original')).length,
      chinese: summaries.filter((s) => /[\u4e00-\u9fff]/u.test(String(s.textContent ?? ''))).length,
      translateCalls: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate')).length,
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
    }
  })
  await page.screenshot({ path: 'test/evidence/e2e-second-session.png' })

  // Switch back to the first lab session.
  const switchStart = await page.evaluate(() => performance.now())
  await page.getByRole('treeitem', { name: /React render clobbering/ }).first().click()
  await page.waitForFunction(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const summaries = rows.map((row) => { const sep = row.querySelector('[data-shimmer-decoration]'); return sep === null ? null : sep.nextElementSibling }).filter(Boolean)
    return summaries.length > 0 && summaries.every((s) => s.hasAttribute('data-dsh-thinking-zh-original'))
  }, undefined, { timeout: 60000 })
  const restoredMs = await page.evaluate((started) => Math.round(performance.now() - started), switchStart)
  await page.waitForTimeout(1500)
  const back = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const summaries = rows.map((row) => { const sep = row.querySelector('[data-shimmer-decoration]'); return sep === null ? null : sep.nextElementSibling }).filter(Boolean)
    return {
      title: document.title,
      rows: rows.length,
      translated: summaries.filter((s) => s.hasAttribute('data-dsh-thinking-zh-original')).length,
      translateCalls: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate')).length,
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
    }
  })
  await page.screenshot({ path: 'test/evidence/e2e-back-to-first.png' })

  return JSON.stringify({
    firstTitle,
    secondSession,
    switchBackRestoredMs: restoredMs,
    back,
    translateCallsDuringSwitch: back.translateCalls - base.translateCalls,
    errors,
  })
}
