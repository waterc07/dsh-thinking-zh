async (page) => {
  const info = await page.evaluate(() => ({
    hasDebug: typeof window.__dshThinkingZh,
    status: window.__dshThinkingZh ? window.__dshThinkingZh.status() : null,
    thinkRows: document.querySelectorAll('[data-variant="think"]').length,
    previewRows: document.querySelectorAll('[data-preview]').length,
    translated: document.querySelectorAll('[data-dsh-thinking-zh-original]').length,
    bodyTextLength: document.body ? document.body.innerText.length : -1,
  }))
  return JSON.stringify(info)
}
