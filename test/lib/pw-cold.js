async (page) => {
  await page.evaluate(() => {
    window.__coldTrace = { beforeRows: document.querySelectorAll('[data-variant="think"]').length, previewAt: 0, chineseAt: 0, previewText: '', sendAt: 0, requestStart: [] }
    const check = () => {
      const trace = window.__coldTrace
      const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
      for (let index = trace.beforeRows; index < rows.length; index += 1) {
        const row = rows[index]
        const sep = row.querySelector('[data-shimmer-decoration]')
        const summary = sep === null ? null : sep.nextElementSibling
        if (summary === null) continue
        const text = String(summary.textContent ?? '').trim()
        if (text === '') continue
        if (!trace.previewAt) {
          trace.previewAt = performance.now()
          trace.previewText = text.slice(0, 120)
        }
        if (!trace.chineseAt && /[\u4e00-\u9fff]/u.test(text)) {
          trace.chineseAt = performance.now()
          trace.chineseText = text.slice(0, 120)
        }
      }
    }
    window.__coldObserver = new MutationObserver(check)
    window.__coldObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
  })

  const prompts = [
    'Think in English. Give three short bullet points about how a browser extension can detect whether a transcript row is collapsed or expanded without relying on CSS-module class names. Answer briefly.',
    'Think in English. In two short paragraphs, explain why a translation cache keyed by a hash of the source sentence is safer than storing the raw sentence, and name one tradeoff. Keep it brief.',
  ]

  const results = []
  for (const prompt of prompts) {
    await page.evaluate(() => { window.__coldTrace.beforeRows = document.querySelectorAll('[data-variant="think"]').length })
    await page.getByRole('textbox', { name: /发消息|描述你想要构建/ }).fill(prompt)
    await page.evaluate(() => {
      window.__coldTrace.beforeRows = document.querySelectorAll('[data-variant="think"]').length
      window.__coldTrace.previewAt = 0
      window.__coldTrace.chineseAt = 0
      window.__coldTrace.requestStart = []
      window.__coldTrace.sendAt = performance.now()
      window.__coldTrace.resourceBase = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate')).length
    })
    await page.getByRole('button', { name: '发送消息' }).click()
    await page.waitForFunction((before) => {
      const rows = document.querySelectorAll('[data-variant="think"]')
      return rows.length > before && document.querySelector('[data-streaming]') === null
    }, await page.evaluate(() => window.__coldTrace.beforeRows), { timeout: 240000 })
    await page.waitForTimeout(4000)
    const trace = await page.evaluate(() => {
      const t = window.__coldTrace
      const resources = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate'))
      return {
        rowsBefore: t.beforeRows,
        rowsAfter: document.querySelectorAll('[data-variant="think"]').length,
        previewLatencyMs: t.previewAt ? Math.round(t.previewAt - t.sendAt) : null,
        translateLatencyMs: t.previewAt && t.chineseAt ? Math.round(t.chineseAt - t.previewAt) : null,
        totalToChineseMs: t.chineseAt ? Math.round(t.chineseAt - t.sendAt) : null,
        previewText: t.previewText,
        chineseText: t.chineseText ?? '',
        translateRequests: resources.length - (t.resourceBase ?? 0),
        lastRequestDurations: resources.slice(-3).map((entry) => ({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) })),
        status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
        sessionTitle: document.title,
      }
    })
    results.push({ prompt: prompt.slice(0, 60), trace })
  }
  return JSON.stringify(results)
}
