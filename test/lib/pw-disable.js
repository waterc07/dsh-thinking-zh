async (page) => {
  const result = await page.evaluate(async () => {
    const rowState = () => Array.from(document.querySelectorAll('[data-variant="think"][data-preview]')).map((row) => {
      const sep = row.querySelector('[data-shimmer-decoration]')
      const summary = sep === null ? null : sep.nextElementSibling
      return summary === null ? null : {
        hasOriginal: summary.hasAttribute('data-dsh-thinking-zh-original'),
        text: String(summary.textContent ?? '').trim(),
      }
    }).filter(Boolean)

    const post = async (body) => {
      const response = await fetch('/api/dsh-thinking-zh/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, json: await response.json().catch(() => null) }
    }

    const before = rowState()
    const beforeTranslated = before.filter((row) => row.hasOriginal).length

    const off = await post({ enabled: false })
    const offStart = performance.now()
    let restoredMs = -1
    while (performance.now() - offStart < 32_000) {
      const rows = rowState()
      const englishOnly = rows.every((row) => !row.hasOriginal && !/[\u4e00-\u9fff]/u.test(row.text))
      if (englishOnly) { restoredMs = Math.round(performance.now() - offStart); break }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const afterOff = rowState()
    const stillChinese = afterOff.filter((row) => /[\u4e00-\u9fff]/u.test(row.text)).length
    const stillMarked = afterOff.filter((row) => row.hasOriginal).length

    const on = await post({ enabled: true })
    const onStart = performance.now()
    let retranslatedMs = -1
    while (performance.now() - onStart < 15_000) {
      const rows = rowState()
      if (rows.some((row) => row.hasOriginal)) { retranslatedMs = Math.round(performance.now() - onStart); break }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const afterOn = rowState()

    return {
      before: { rows: before.length, translated: beforeTranslated },
      setOff: off,
      restoredMs,
      afterOff: { stillChinese, stillMarked, sample: afterOff.slice(0, 3) },
      setOn: on,
      retranslatedMs,
      afterOn: { translated: afterOn.filter((row) => row.hasOriginal).length },
      debug: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
    }
  })
  return JSON.stringify(result)
}
