async (page) => {
  const before = await page.evaluate(() => document.querySelectorAll('[data-variant="think"]').length)
  await page.evaluate(() => {
    window.__lat = { changes: [], sendAt: 0, translateBase: 0, rowBefore: document.querySelectorAll('[data-variant="think"]').length }
    const snap = () => {
      const rows = Array.from(document.querySelectorAll('[data-variant="think"]'))
      for (let index = window.__lat.rowBefore; index < rows.length; index += 1) {
        const row = rows[index]
        const sep = row.querySelector('[data-shimmer-decoration]')
        const summary = sep === null ? null : sep.nextElementSibling
        if (summary === null) continue
        const text = String(summary.textContent ?? '').trim()
        if (text === '') continue
        const last = window.__lat.changes[window.__lat.changes.length - 1]
        if (last === undefined || last.text !== text) {
          window.__lat.changes.push({ at: performance.now(), text, row: index })
        }
      }
    }
    window.__latObserver = new MutationObserver(snap)
    window.__latObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
  })
  await page.getByRole('textbox', { name: /发消息|描述你想要构建/ }).fill(
    'Think in English. Explain in 4 short bullets how to make a UI overlay resilient when the host framework re-renders frequently. Answer briefly, no tools needed.',
  )
  await page.evaluate(() => {
    window.__lat.rowBefore = document.querySelectorAll('[data-variant="think"]').length
    window.__lat.translateBase = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate')).length
    window.__lat.sendAt = performance.now()
  })
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.waitForFunction((beforeCount) => {
    return document.querySelectorAll('[data-variant="think"]').length > beforeCount && document.querySelector('[data-streaming]') === null
  }, before, { timeout: 240000 })
  await page.waitForTimeout(5000)

  return JSON.stringify(await page.evaluate(() => {
    const changes = window.__lat.changes
    const english = changes.filter((change) => /[A-Za-z]/.test(change.text) && !/[\u4e00-\u9fff]/u.test(change.text))
    const lastEnglish = english[english.length - 1]
    const chinese = changes.filter((change) => /[\u4e00-\u9fff]/u.test(change.text))
    const firstChinese = chinese[0]
    const resources = performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/api/dsh-thinking-zh/translate'))
    return {
      sendAt: Math.round(window.__lat.sendAt),
      changeCount: changes.length,
      englishPreviewChanges: english.map((change) => ({ at: Math.round(change.at), text: change.text.slice(0, 70) })),
      chineseChanges: chinese.map((change) => ({ at: Math.round(change.at), text: change.text.slice(0, 70) })),
      finalEnglishAt: lastEnglish === undefined ? null : Math.round(lastEnglish.at),
      firstChineseAt: firstChinese === undefined ? null : Math.round(firstChinese.at),
      stableToChineseMs: lastEnglish !== undefined && firstChinese !== undefined ? Math.round(firstChinese.at - lastEnglish.at) : null,
      translateRequestsAdded: resources.length - window.__lat.translateBase,
      status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
      rows: document.querySelectorAll('[data-variant="think"]').length,
    }
  }))
}
