/**
 * `dsh-thinking-zh` — browser half.
 *
 * DeepSeek Harness folds the assistant's reasoning into a disclosure row. While
 * that row is collapsed it still renders a one-line preview — the first line of
 * the English reasoning text — so a Chinese reader has to open (and lose) every
 * row just to know what the model was doing. The built-in `cot-translation`
 * plugin translates the *expanded* reasoning body only; this plugin covers the
 * collapsed preview.
 *
 * The preview is plain DOM text underneath the React renderer, so the whole
 * approach is intentionally non-invasive:
 *
 *   - observe the transcript with a `MutationObserver`;
 *   - debounce until the streaming preview stops changing (~400ms);
 *   - batch the stable English strings to the host half's loopback route
 *     (`POST /api/dsh-thinking-zh/translate`, at most 8 segments per call);
 *   - write the Chinese result into the *existing text node*, keeping the
 *     English original in `title` + `data-dsh-thinking-zh-original`.
 *
 * DOM structure, element and text-node writes only: no inserted or removed
 * elements, no `innerHTML`, no React-managed state. React overwrites the text
 * node when new reasoning streams in; the observer catches that and re-applies
 * from the in-memory translation map (the host caches on disk as well), so a
 * re-render costs no network request.
 *
 * Everything is wrapped in `try/catch`; a translation failure must never break
 * the conversation UI. Diagnostics (the only "eyes" this plugin has inside the
 * page) are POSTed to `/api/dsh-thinking-zh/diag`.
 */

;(function () {
  /**
   * Build one module instance (the plugin's browser half).
   * @returns {{ apply: (ctx: unknown) => void, inject: string[] }}
   */
  function createModule() {
    /** Host routes owned by the host half of this plugin (same origin). */
    const API = {
      state: '/api/dsh-thinking-zh/state',
      translate: '/api/dsh-thinking-zh/translate',
      diag: '/api/dsh-thinking-zh/diag',
    }

    /**
     * Reasoning disclosure root. `data-variant="think"` is a semantic hook the
     * chat renderer emits for the assistant reasoning row; the surrounding
     * `data-state` / `data-expanded` / `data-preview` attributes complete the
     * state machine without depending on build-generated CSS-module hashes.
     */
    const ROW_SELECTOR = '[data-variant="think"]'
    /** Preview container: the span immediately after the shimmer separator. */
    const SEPARATOR_SELECTOR = '[data-shimmer-decoration]'
    /** Attribute set once this text node's content was replaced. */
    const ATTR_ORIGINAL = 'data-dsh-thinking-zh-original'
    /** Attribute carrying the Chinese text currently written into the node. */
    const ATTR_TRANSLATION = 'data-dsh-thinking-zh-translation'
    /** Marker for the row-level diagnostic snapshot. */
    const ATTR_DEBUG = 'data-dsh-thinking-zh-state'

    /**
     * How long a preview string must stay unchanged before it is translated.
     * The stability clock is per *string*, not per page: the answer keeps
     * streaming into the transcript long after the reasoning preview settled,
     * and a page-wide debounce would postpone the preview for its whole answer.
     */
    const STABILITY_MS = 400
    /** Segments per host request (mirrors the host contract). */
    const MAX_SEGMENTS = 8
    /** Shortest preview worth translating. */
    const MIN_CHARS = 6
    /** Translated strings kept in memory for re-render recovery. */
    const MAX_MEMORY = 400
    /** Retry a failed string only after this long. */
    const FAILED_TTL_MS = 60_000
    /** How often the enabled/target-language preference is re-read. */
    const STATE_POLL_MS = 20_000

    /** Whether the host reports the plugin enabled. */
    let enabled = true
    /** Target language tag requested from the host. */
    let targetLanguage = 'zh-Hans'
    /** Transcript observer. */
    let observer = null
    /** Pending translation deadline. */
    let passTimer = 0
    /** A scan for the current animation frame is already queued. */
    let scanQueued = false
    /** Whether a translation pass is in flight. */
    let running = false
    /** A mutation arrived while a pass was running. */
    let dirty = false
    /** Teardown flag. */
    let disposed = false
    /** Periodic preference poll handle. */
    let stateTimer = 0
    /** One diagnostic snapshot per page load. */
    let diagSent = false
    /** Counts passes, so a stuck pass is visible from the console. */
    let passCount = 0
    /** Bounded in-page event log for lab diagnostics. */
    const events = []
    /** Preview string -> timestamp it was first observed (stability clock). */
    const stability = new Map()
    /** Last recorded candidate set, so the event log stays readable. */
    let lastScanSignature = ''

    /** Append one bounded diagnostic event (never throws). */
    function record(event, detail) {
      try {
        let encoded = ''
        try {
          encoded = clamp(JSON.stringify(detail ?? null), 600)
        } catch {
          encoded = '[unserializable]'
        }
        events.push({ at: new Date().toISOString().slice(11, 23), event, detail: encoded })
        if (events.length > 120) events.shift()
      } catch { /* logging is optional */ }
    }

    /** Original English -> Chinese, so a React re-render never costs a request. */
    const translations = new Map()
    /** Original English -> timestamp of the last failed attempt. */
    const failed = new Map()
    /** Strings a speculative request is already in flight for. */
    const inflight = new Set()

    const TEARDOWN_KEY = '__dshThinkingZhDispose'
    const DEBUG_KEY = '__dshThinkingZh'

    /** Resolve after `ms` milliseconds. */
    function delay(ms) {
      return new Promise((resolve) => {
        window.setTimeout(resolve, ms)
      })
    }

    /** Clamp a string for a diagnostic payload. */
    function clamp(value, limit) {
      const text = String(value ?? '')
      return text.length <= limit ? text : `${text.slice(0, limit)}…[${String(text.length)} chars]`
    }

    /** Collect one element's attributes as a plain object. */
    function attributesOf(element) {
      const out = {}
      for (const attribute of element.attributes) out[attribute.name] = clamp(attribute.value, 200)
      return out
    }

    /** Every text node under an element, in document order. */
    function textNodesOf(element) {
      const nodes = []
      try {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node !== null) {
          nodes.push(node)
          node = walker.nextNode()
        }
      } catch { /* detached subtree: no text nodes */ }
      return nodes
    }

    /** The first non-blank text node under an element, or null. */
    function primaryTextNode(element) {
      for (const node of textNodesOf(element)) {
        if (String(node.nodeValue ?? '').trim() !== '') return node
      }
      return null
    }

    /**
     * POST one diagnostic payload to the host (best effort, never throws).
     * @param name - File stem under `$DSH_HOME/dsh-thinking-zh/diag/`.
     * @param payload - Arbitrary JSON-serializable structure.
     */
    function postDiag(name, payload) {
      try {
        void fetch(API.diag, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, payload }),
          cache: 'no-store',
        }).catch(() => {})
      } catch { /* diagnostics are optional */ }
    }

    /**
     * Snapshot enough of the live DOM to re-derive selectors offline.
     * @param reason - Why the snapshot was taken.
     * @returns the JSON payload written under the diag directory.
     */
    function diagPayload(reason) {
      const payload = {
        reason,
        href: clamp(location.href, 300),
        readyState: document.readyState,
        plugin: {
          enabled,
          targetLanguage,
          passes: passCount,
          translations: translations.size,
          failed: failed.size,
        },
        counts: {
          thinkRows: 0,
          expandedRows: 0,
          previewRows: 0,
          shimmerSeparators: 0,
          shimmerSeparatorSiblings: 0,
          stepProcessRows: 0,
          dataVariantValues: [],
        },
        rows: [],
      }
      try {
        const rows = Array.from(document.querySelectorAll(ROW_SELECTOR))
        payload.counts.thinkRows = rows.length
        payload.counts.expandedRows = rows.filter((row) => row.hasAttribute('data-expanded')).length
        payload.counts.previewRows = rows.filter((row) => row.hasAttribute('data-preview')).length
        payload.counts.shimmerSeparators = document.querySelectorAll(SEPARATOR_SELECTOR).length
        payload.counts.stepProcessRows = document.querySelectorAll('[data-step-process]').length
        payload.counts.dataVariantValues = Array.from(
          new Set(Array.from(document.querySelectorAll('[data-variant]')).map((node) => node.getAttribute('data-variant'))),
        ).slice(0, 20)
        for (const separator of document.querySelectorAll(SEPARATOR_SELECTOR)) {
          if (separator.nextElementSibling !== null) payload.counts.shimmerSeparatorSiblings += 1
        }
        payload.rows = rows.slice(0, 8).map((row) => {
          const summary = findSummary(row)
          return {
            attributes: attributesOf(row),
            expanded: row.hasAttribute('data-expanded'),
            preview: row.hasAttribute('data-preview'),
            text: clamp(String(row.textContent ?? '').trim(), 400),
            html: clamp(row.innerHTML, 3000),
            summary: summary === null ? null : {
              tag: summary.tagName,
              attributes: attributesOf(summary),
              html: clamp(summary.innerHTML, 1500),
              text: clamp(String(summary.textContent ?? '').trim(), 600),
              textNodes: textNodesOf(summary).slice(0, 8).map((node) => clamp(node.nodeValue, 300)),
            },
          }
        })
        if (rows.length === 0) {
          payload.generic = {
            bodyText: clamp(String(document.body?.innerText ?? '').trim(), 1200),
            dataAttributeNames: Array.from(new Set(
              Array.from(document.querySelectorAll('[class]')).flatMap((node) => Array.from(node.attributes))
                .map((attribute) => attribute.name)
                .filter((name) => name.startsWith('data-')),
            )).slice(0, 120),
            bodyHtml: clamp(document.body?.innerHTML ?? '', 4000),
          }
        }
      } catch (error) {
        payload.diagError = error instanceof Error ? error.message : String(error)
      }
      return payload
    }

    /**
     * The collapsed preview container of one reasoning row.
     * @param row - A `[data-variant="think"]` row.
     * @returns the summary span, or null when this row renders no preview.
     */
    function findSummary(row) {
      try {
        for (const separator of row.querySelectorAll(SEPARATOR_SELECTOR)) {
          const sibling = separator.nextElementSibling
          if (sibling !== null && String(sibling.textContent ?? '').trim() !== '') return sibling
        }
        return row.querySelector('[data-streaming]')
      } catch {
        return null
      }
    }

    /** CJK / kana / hangul characters in a string. */
    function cjkCount(text) {
      const matches = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu)
      return matches === null ? 0 : matches.length
    }

    /** Latin letters in a string. */
    function letterCount(text) {
      const matches = text.match(/[A-Za-z]/gu)
      return matches === null ? 0 : matches.length
    }

    /**
     * Whether a preview string should be left alone, and why.
     * Skips code, URLs and commands, numeric/symbol noise, short strings and
     * text that is already mostly Chinese.
     * @param text - Trimmed preview text.
     * @returns null when the text is worth translating, else a short reason.
     */
    function skipReason(text) {
      const value = text.trim()
      if (value.length < MIN_CHARS) return 'too-short'
      const letters = letterCount(value)
      const cjk = cjkCount(value)
      // Pure numbers, punctuation, emoji, or already CJK text.
      if (letters === 0) return 'no-letters'
      if (cjk >= 2 && cjk / Math.max(letters, 1) > 0.25) return 'already-chinese'
      // URLs and inline code / shell fragments.
      if (/^(?:https?:\/\/|ftp:\/\/|www\.)\S*$/iu.test(value)) return 'url'
      if (/^[`$>#]\s?/u.test(value)) return 'prompt-or-code'
      if (/^(?:git|npm|pnpm|npx|node|deno|bun|cd|ls|dir|cat|curl|sudo|python|pip|pwsh|powershell|mkdir|rm|cp|mv|echo)\s/u.test(value)) return 'command'
      // Paths, identifiers and other single tokens carry no prose to translate.
      if (!/\s/u.test(value) && /^[\w./\\:@~%+=-]+$/u.test(value)) return 'single-token'
      // Markdown table rows / code-ish lines.
      if (/^\s*[|`{}<>]/u.test(value) && !/[.!?,，。？！]/u.test(value)) return 'code-ish'
      return null
    }

    /** {@link skipReason} as a boolean. */
    function shouldSkip(text) {
      return skipReason(text) !== null
    }

    /** One row's translation decision, for lab diagnostics. */
    function debugRows() {
      try {
        return Array.from(document.querySelectorAll(ROW_SELECTOR)).slice(0, 6).map((row) => {
          const summary = findSummary(row)
          const current = summary === null ? null : String(summary.textContent ?? '').trim()
          return {
            expanded: row.hasAttribute('data-expanded'),
            preview: row.hasAttribute('data-preview'),
            summaryFound: summary !== null,
            current: current === null ? null : clamp(current, 200),
            skipReason: current === null ? null : skipReason(current),
            cached: current === null ? null : translations.has(current),
            summaryAttrs: summary === null ? null : Array.from(summary.attributes).map((attribute) => attribute.name),
          }
        })
      } catch (error) {
        return [{ error: error instanceof Error ? error.message : String(error) }]
      }
    }

    /** Write `translation` into the preview's existing text node. */
    function applyTranslation(summary, original, translation) {
      try {
        const nodes = textNodesOf(summary)
        const primary = primaryTextNode(summary)
        if (primary === null) {
          record('apply:no-text-node', { original })
          return false
        }
        const value = String(primary.nodeValue ?? '')
        const leading = (value.match(/^\s*/u) ?? [''])[0]
        const trailing = (value.match(/\s*$/u) ?? [''])[0]
        primary.nodeValue = `${leading}${translation}${trailing}`
        for (const node of nodes) {
          if (node === primary) continue
          if (String(node.nodeValue ?? '').trim() !== '') node.nodeValue = ''
        }
        summary.setAttribute('title', original)
        summary.setAttribute(ATTR_ORIGINAL, original)
        summary.setAttribute(ATTR_TRANSLATION, translation)
        summary.setAttribute(ATTR_DEBUG, 'translated')
        record('apply:ok', {
          original: clamp(original, 120),
          translation: clamp(translation, 120),
          nodes: nodes.length,
          textAfter: clamp(String(summary.textContent ?? '').trim(), 120),
        })
        return true
      } catch (error) {
        record('apply:error', error instanceof Error ? error.message : String(error))
        return false
      }
    }

    /** Restore every preview this instance translated. */
    function restoreAll() {
      try {
        for (const summary of document.querySelectorAll(`[${ATTR_ORIGINAL}]`)) {
          try {
            const original = summary.getAttribute(ATTR_ORIGINAL)
            const translation = summary.getAttribute(ATTR_TRANSLATION)
            if (original !== null && translation !== null) {
              const primary = primaryTextNode(summary)
              if (primary !== null && String(primary.nodeValue ?? '').trim() === translation.trim()) {
                primary.nodeValue = original
              }
            }
            summary.removeAttribute('title')
            summary.removeAttribute(ATTR_ORIGINAL)
            summary.removeAttribute(ATTR_TRANSLATION)
            summary.removeAttribute(ATTR_DEBUG)
          } catch { /* one node must not abort the sweep */ }
        }
      } catch { /* page teardown */ }
    }

    /** Remember one successful translation, trimming the oldest entries. */
    function remember(original, translation) {
      translations.delete(original)
      translations.set(original, translation)
      failed.delete(original)
      while (translations.size > MAX_MEMORY) {
        const oldest = translations.keys().next()
        if (oldest.done === true) break
        translations.delete(oldest.value)
      }
    }

    /**
     * POST up to {@link MAX_SEGMENTS} strings to the host.
     * @param texts - Unique English strings, in display order.
     * @returns one translated string (or null) per input position.
     */
    async function translateBatch(texts) {
      try {
        const response = await fetch(API.translate, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ segments: texts.map((text, index) => ({ id: String(index), text })) }),
          cache: 'no-store',
        })
        if (!response.ok) return []
        const payload = await response.json()
        const results = payload?.results
        if (!Array.isArray(results)) return []
        const byId = new Map()
        for (const result of results) {
          if (result !== null && typeof result === 'object') byId.set(String(result.id), result.text)
        }
        return texts.map((_, index) => byId.get(String(index)) ?? null)
      } catch {
        return []
      }
    }

    /** Current collapsed-preview candidates, cheapest work first. */
    function gather() {
      const candidates = []
      let rows
      try {
        rows = document.querySelectorAll(ROW_SELECTOR)
      } catch {
        return candidates
      }
      for (const row of rows) {
        try {
          if (!row.hasAttribute('data-preview')) continue
          if (row.hasAttribute('data-expanded')) continue
          const summary = findSummary(row)
          if (summary === null) continue
          const current = String(summary.textContent ?? '').trim()
          if (current === '') continue
          const translationAttr = summary.getAttribute(ATTR_TRANSLATION)
          if (translationAttr !== null && current === translationAttr) continue
          if (shouldSkip(current)) continue
          candidates.push({ summary, original: current, cached: translations.get(current) })
        } catch { /* one broken row must not skip the rest */ }
      }
      return candidates
    }

    /**
     * Start the network hop as soon as a preview appears, instead of waiting
     * for the stability delay. Applying still waits for stability; this only
     * moves the slow part of the latency (the translation request) earlier, so
     * a settled preview flips to Chinese in a few milliseconds.
     * @param candidates - Current collapsed previews.
     */
    function prefetch(candidates) {
      const texts = []
      const seen = new Set()
      for (const candidate of candidates) {
        const key = candidate.original
        if (typeof candidate.cached === 'string') continue
        if (translations.has(key) || inflight.has(key) || seen.has(key)) continue
        const failure = failed.get(key)
        if (failure !== undefined && Date.now() - failure < FAILED_TTL_MS) continue
        seen.add(key)
        inflight.add(key)
        texts.push(key)
      }
      if (texts.length === 0) return
      record('prefetch', { texts: texts.map((text) => clamp(text, 120)) })
      void (async () => {
        try {
          for (let offset = 0; offset < texts.length; offset += MAX_SEGMENTS) {
            if (disposed || !enabled) return
            const batch = texts.slice(offset, offset + MAX_SEGMENTS)
            const results = await translateBatch(batch)
            batch.forEach((original, index) => {
              const translated = results[index]
              if (typeof translated === 'string' && translated.trim() !== '' && translated !== original) {
                remember(original, translated)
                record('translate:ok', { original: clamp(original, 120), translation: clamp(translated, 120) })
              } else {
                failed.set(original, Date.now())
                record('translate:fail', { original: clamp(original, 120) })
              }
            })
          }
        } catch (error) {
          record('prefetch:error', error instanceof Error ? error.message : String(error))
        } finally {
          for (const text of texts) inflight.delete(text)
        }
        // Applying is the pass's job once the text has been stable for 400ms.
        requestScan()
      })()
    }

    /**
     * One translation pass: apply stable cached results, translate stable
     * previews that have no result yet, then apply and re-arm.
     */
    async function pass() {
      if (!enabled || disposed) return
      if (running) {
        dirty = true
        return
      }
      running = true
      passCount += 1
      try {
        const candidates = gather()
        if (!diagSent && candidates.length > 0) {
          diagSent = true
          postDiag('preview-dom', diagPayload('first-pass'))
        }
        const now = Date.now()
        record('pass', { passCount, candidates: candidates.map((entry) => clamp(entry.original, 120)) })
        /** Stable previews first: apply what is ready, request the rest. */
        const pending = []
        const seen = new Set()
        for (const candidate of candidates) {
          const original = candidate.original
          const firstSeen = stability.get(original) ?? now
          if (now - firstSeen < STABILITY_MS) continue
          if (typeof candidate.cached === 'string') {
            if (!applyTranslation(candidate.summary, original, candidate.cached)) {
              // A node that cannot be written (detached mid-render) must not spin
              // the pass loop; retry it later like a failed translation.
              failed.set(original, Date.now())
            }
            continue
          }
          if (inflight.has(original)) continue
          if (seen.has(original)) continue
          const failure = failed.get(original)
          if (failure !== undefined && now - failure < FAILED_TTL_MS) continue
          seen.add(original)
          pending.push(original)
        }
        for (let offset = 0; offset < pending.length; offset += MAX_SEGMENTS) {
          if (disposed || !enabled) return
          const batch = pending.slice(offset, offset + MAX_SEGMENTS)
          const results = await translateBatch(batch)
          batch.forEach((original, index) => {
            const translated = results[index]
            if (typeof translated === 'string' && translated.trim() !== '' && translated !== original) {
              remember(original, translated)
              record('translate:ok', { original: clamp(original, 120), translation: clamp(translated, 120) })
            } else {
              failed.set(original, Date.now())
              record('translate:fail', { original: clamp(original, 120) })
            }
          })
        }
        for (const candidate of gather()) {
          const firstSeen = stability.get(candidate.original) ?? now
          if (now - firstSeen < STABILITY_MS) continue
          const translated = translations.get(candidate.original)
          if (typeof translated !== 'string') continue
          if (!applyTranslation(candidate.summary, candidate.original, translated)) {
            failed.set(candidate.original, Date.now())
          }
        }
      } catch (error) {
        record('pass:error', error instanceof Error ? error.message : String(error))
      } finally {
        running = false
      }
      // Re-arm for text that arrived or settled while this pass was running.
      dirty = false
      requestScan()
    }

    /**
     * Re-read every collapsed preview, start speculative translations, and arm
     * the pass timer for the earliest string that is about to become stable.
     * Cheap enough to run on every animation frame; unrelated transcript
     * mutations never postpone it.
     */
    function scan() {
      if (!enabled || disposed) return
      try {
        const now = Date.now()
        const candidates = gather()
        prefetch(candidates)
        const live = new Set()
        const pending = []
        let deadline = -1
        for (const candidate of candidates) {
          const key = candidate.original
          live.add(key)
          pending.push(key)
          if (!stability.has(key)) stability.set(key, now)
          const age = now - stability.get(key)
          if (age < STABILITY_MS) {
            const wait = STABILITY_MS - age
            if (deadline === -1 || wait < deadline) deadline = wait
            continue
          }
          if (typeof candidate.cached === 'string') {
            // A translation is ready; apply it as soon as the text is stable.
            deadline = 0
            continue
          }
          const failure = failed.get(key)
          if (failure !== undefined && now - failure < FAILED_TTL_MS) continue
          // Wait for the speculative request; its completion re-scans.
          if (inflight.has(key)) continue
          deadline = 0
        }
        for (const key of Array.from(stability.keys())) {
          if (!live.has(key)) stability.delete(key)
        }
        const signature = pending.join('\u0000')
        if (signature !== lastScanSignature) {
          lastScanSignature = signature
          record('scan', { candidates: pending.map((entry) => clamp(entry, 120)) })
        }
        if (deadline === -1) {
          if (passTimer !== 0) {
            window.clearTimeout(passTimer)
            passTimer = 0
          }
          return
        }
        armPass(deadline)
      } catch (error) {
        record('scan:error', error instanceof Error ? error.message : String(error))
      }
    }

    /** Arm (or re-arm) the next translation pass. */
    function armPass(ms) {
      if (passTimer !== 0) window.clearTimeout(passTimer)
      passTimer = window.setTimeout(() => {
        passTimer = 0
        void pass()
      }, Math.max(0, ms))
    }

    /** Coalesce transcript mutations into one scan per animation frame. */
    function requestScan() {
      if (!enabled || disposed || scanQueued) return
      scanQueued = true
      const flush = () => {
        scanQueued = false
        scan()
      }
      try {
        window.requestAnimationFrame(flush)
      } catch {
        window.setTimeout(flush, 16)
      }
    }

    /** Adopt one host state payload. */
    function adoptState(payload) {
      if (payload === null || typeof payload !== 'object') return
      const wasEnabled = enabled
      if (typeof payload.enabled === 'boolean') enabled = payload.enabled
      if (typeof payload.targetLanguage === 'string' && payload.targetLanguage !== '') {
        targetLanguage = payload.targetLanguage
      }
      if (wasEnabled && !enabled) {
        if (passTimer !== 0) {
          window.clearTimeout(passTimer)
          passTimer = 0
        }
        restoreAll()
      }
      if (!wasEnabled && enabled) requestScan()
    }

    /**
     * Prime the host's upstream connection once per page load. The first
     * translation of a page pays the TLS handshake to the public endpoint
     * (~900ms) instead of the ~250ms a warm connection costs; a page that opens
     * straight into a fresh conversation would otherwise miss the 1s target on
     * its very first preview. The host caches by text, so this costs one tiny
     * request per page load and is never repeated.
     */
    async function warmUp() {
      try {
        if (disposed || !enabled) return
        await translateBatch(['Ready.'])
        record('warmup:ok', null)
      } catch { /* warm-up is an optimization only */ }
    }

    /** Read the host preferences; a missing host leaves the defaults in place. */
    async function loadState() {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (disposed) return
        try {
          const response = await fetch(API.state, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          adoptState(await response.json())
          return
        } catch {
          await delay(300 * (attempt + 1))
        }
      }
    }

    /** Re-read the preference on a slow cadence so `/set` takes effect live. */
    async function refreshState() {
      if (disposed) return
      try {
        const response = await fetch(API.state, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (!response.ok) return
        adoptState(await response.json())
      } catch { /* keep the last known preference */ }
    }

    /** Watch the transcript and translate settled previews. */
    function startWatching() {
      if (observer !== null) observer.disconnect()
      try {
        observer = new MutationObserver(() => {
          if (!enabled || disposed) return
          requestScan()
        })
        observer.observe(document.body ?? document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        })
      } catch {
        observer = null
      }
      stateTimer = window.setInterval(() => {
        void refreshState()
      }, STATE_POLL_MS)
      // The transcript may already be rendered before this plugin starts.
      requestScan()
      // One late diagnostic when the page never produced a reasoning row, so a
      // selector drift is still debuggable from `$DSH_HOME/dsh-thinking-zh/diag`.
      window.setTimeout(() => {
        try {
          if (!diagSent) postDiag('no-think-rows', diagPayload('no-think-rows'))
        } catch { /* optional */ }
      }, 6000)
    }

    function dispose() {
      disposed = true
      observer?.disconnect()
      observer = null
      if (passTimer !== 0) {
        window.clearTimeout(passTimer)
        passTimer = 0
      }
      if (stateTimer !== 0) {
        window.clearInterval(stateTimer)
        stateTimer = 0
      }
      restoreAll()
      if (window[DEBUG_KEY] !== undefined) window[DEBUG_KEY] = undefined
    }

    function apply(ctx) {
      // A hot reload may start a second instance; retire the previous one first.
      try {
        if (typeof window[TEARDOWN_KEY] === 'function') window[TEARDOWN_KEY]()
      } catch { /* previous instance already gone */ }
      disposed = false
      diagSent = false
      passCount = 0
      enabled = true
      running = false
      dirty = false
      scanQueued = false
      translations.clear()
      failed.clear()
      stability.clear()
      inflight.clear()
      lastScanSignature = ''
      const teardown = () => {
        if (disposed) return
        dispose()
        window[TEARDOWN_KEY] = undefined
      }
      window[TEARDOWN_KEY] = teardown
      // Debug surface for the lab: `await window.__dshThinkingZh.diag()` writes
      // one snapshot and returns a local summary (no DevTools required).
      window[DEBUG_KEY] = {
        pass: () => pass(),
        diag: (name) => postDiag(name ?? 'manual', diagPayload('manual')),
        snapshot: () => diagPayload('snapshot'),
        rows: () => debugRows(),
        events: () => events.slice(),
        status: () => ({
          enabled,
          targetLanguage,
          passes: passCount,
          translated: translations.size,
          failed: failed.size,
          inflight: inflight.size,
          rows: document.querySelectorAll(ROW_SELECTOR).length,
        }),
      }
      if (typeof document !== 'undefined' && document.body === null) {
        window.addEventListener('DOMContentLoaded', () => {
          void loadState()
          startWatching()
          void warmUp()
        }, { once: true })
      } else {
        void loadState()
        startWatching()
        // Warm the translation connection in the background while the reader
        // types the first prompt.
        void warmUp()
      }
      if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
        ctx.effect(() => teardown, 'dsh-thinking-zh: collapsed reasoning preview')
      }
    }

    const inject = []

    return { apply, inject }
  }

  window.__ModuleLoader__.load({
    id: 'dsh-thinking-zh',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      const api = createModule()
      exports.apply = api.apply
      exports.inject = api.inject
      return module.exports
    },
  })
})()

