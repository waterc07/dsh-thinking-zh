async (page) => {
  const start = Date.now()
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('[data-variant="think"]')
    if (rows.length === 0) return false
    return document.querySelector('[data-streaming]') === null
  }, undefined, { timeout: 240000 })
  await page.waitForTimeout(3000)
  return JSON.stringify(await page.evaluate((startedAt) => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const previews = rows.filter((row) => row.hasAttribute('data-preview'))
    const summaries = previews.map((row) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      return sep === null ? null : sep.nextElementSibling
    }).filter(Boolean)
    return {
      waitedMs: Date.now() - startedAt,
      thinkRows: rows.length,
      previewRows: previews.length,
      translated: summaries.filter((summary) => summary.hasAttribute('data-dsh-thinking-zh-original')).length,
      chinese: summaries.filter((summary) => /[\u4e00-\u9fff]/u.test(String(summary.textContent ?? ''))).length,
      previewTexts: summaries.map((summary) => String(summary.textContent ?? '').trim().slice(0, 100)),
      titles: summaries.map((summary) => String(summary.getAttribute('title') ?? '').slice(0, 100)),
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
      sessionTitle: document.title,
    }
  }, start))
}
