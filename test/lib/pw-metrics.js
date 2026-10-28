async (page) => {
  await page.addInitScript(() => {
    window.__zhTiming = { firstPreviewAt: 0, firstChineseAt: 0, firstAttrAt: 0 }
    const check = () => {
      try {
        const rows = document.querySelectorAll('[data-variant="think"][data-preview]')
        for (const row of rows) {
          const sep = row.querySelector('[data-shimmer-decoration]')
          const summary = sep === null ? null : sep.nextElementSibling
          if (summary === null) continue
          const text = String(summary.textContent ?? '').trim()
          if (text === '') continue
          if (!window.__zhTiming.firstPreviewAt) window.__zhTiming.firstPreviewAt = performance.now()
          if (/[\u4e00-\u9fff]/u.test(text) && !window.__zhTiming.firstChineseAt) {
            window.__zhTiming.firstChineseAt = performance.now()
          }
          if (summary.hasAttribute('data-dsh-thinking-zh-original') && !window.__zhTiming.firstAttrAt) {
            window.__zhTiming.firstAttrAt = performance.now()
          }
        }
      } catch { /* timing is optional */ }
    }
    new MutationObserver(check).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
    })
  })

  await page.reload()
  await page.waitForSelector('[data-variant="think"]', { state: 'attached', timeout: 20000 })
  await page.waitForFunction(() => window.__dshThinkingZh !== undefined, undefined, { timeout: 20000 })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: 'test/evidence/e2e-hot-reload.png' })

  return JSON.stringify(await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
    const previewRows = rows.filter((row) => row.hasAttribute('data-preview'))
    const translated = rows.filter((row) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      const summary = sep === null ? null : sep.nextElementSibling
      return summary !== null && summary.hasAttribute('data-dsh-thinking-zh-original')
    })
    const samples = translated.slice(0, 5).map((row) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      const summary = sep === null ? null : sep.nextElementSibling
      return {
        title: summary.getAttribute('title'),
        originalAttr: summary.getAttribute('data-dsh-thinking-zh-original'),
        translationAttr: summary.getAttribute('data-dsh-thinking-zh-translation'),
        currentText: String(summary.textContent ?? '').trim(),
        titleEqualsOriginal: summary.getAttribute('title') === summary.getAttribute('data-dsh-thinking-zh-original'),
        titleHasCjk: /[\u4e00-\u9fff]/u.test(String(summary.getAttribute('title') ?? '')),
        currentHasCjk: /[\u4e00-\u9fff]/u.test(String(summary.textContent ?? '')),
      }
    })
    const resources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/api/dsh-thinking-zh/'))
      .map((entry) => ({ name: entry.name.split('/api/')[1], start: Math.round(entry.startTime), duration: Math.round(entry.duration) }))
    const status = window.__dshThinkingZh ? window.__dshThinkingZh.status() : null
    const debugRows = window.__dshThinkingZh ? window.__dshThinkingZh.rows() : []
    const untranslated = debugRows.filter((row) => row && row.cached === false && row.summaryFound)
    return {
      timing: window.__zhTiming,
      requestCount: { translate: resources.filter((r) => r.name.includes('translate')).length, state: resources.filter((r) => r.name.includes('state')).length, total: resources.length },
      firstTranslateRequests: resources.filter((r) => r.name.includes('translate')).slice(0, 6),
      counts: { rows: rows.length, previewRows: previewRows.length, translated: translated.length },
      samples,
      status,
      untranslatedSample: untranslated.slice(0, 6),
      sessionTitle: document.title,
    }
  }))
}
