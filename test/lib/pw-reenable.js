async (page) => {
  const start = Date.now()
  await page.waitForFunction(() => window.__dshThinkingZh && window.__dshThinkingZh.status().enabled === true, undefined, { timeout: 40000 }).catch(() => {})
  const enabledAt = Date.now() - start
  await page.waitForTimeout(3000)
  return JSON.stringify(await page.evaluate(async (ms) => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const summaries = rows.map((row) => { const sep = row.querySelector('[data-shimmer-decoration]'); return sep === null ? null : sep.nextElementSibling }).filter(Boolean)
    const state = await fetch('/api/dsh-thinking-zh/state').then((r) => r.json())
    return {
      adoptDelayMs: ms,
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
      rows: rows.length,
      translated: summaries.filter((s) => s.hasAttribute('data-dsh-thinking-zh-original')).length,
      chinese: summaries.filter((s) => /[\u4e00-\u9fff]/u.test(String(s.textContent ?? ''))).length,
      translateCalls: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/dsh-thinking-zh/translate')).length,
      state,
    }
  }, enabledAt))
}
