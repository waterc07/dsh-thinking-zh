async (page) => {
  return JSON.stringify(await page.evaluate(() => {
    const row = document.querySelector('[data-variant="think"][data-preview]')
    if (!row) return { found: false }
    const headerCandidates = Array.from(row.querySelectorAll('[data-disclosure-header], [data-open], button, [role="button"]')).slice(0, 6).map((el) => ({
      tag: el.tagName,
      cls: String(el.className).slice(0, 120),
      attrs: Array.from(el.attributes).map((a) => a.name).join(','),
      text: String(el.textContent ?? '').trim().slice(0, 60),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
    }))
    const r = row.getBoundingClientRect()
    return {
      found: true,
      rowRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      rowAttrs: Array.from(row.attributes).map((a) => `${a.name}=${a.value}`).join(' | ').slice(0, 300),
      headerCandidates,
      rowHtml: row.outerHTML.slice(0, 1500),
    }
  }))
}
