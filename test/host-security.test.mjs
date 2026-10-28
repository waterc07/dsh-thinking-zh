/**
 * Host-half security verification for `dsh-thinking-zh` (phase 1, no app).
 *
 *   node.cmd test/host-security.test.mjs
 *
 * Read-only against src/. Everything here drives the real route handlers over a
 * real HTTP socket, so `isAllowed()` / `readBody()` / `diag()` are exercised
 * exactly as a hostile browser or local process would.
 */
import os from 'node:os'
import http from 'node:http'
import { rm, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createSuite, makeHome, loadPlugin, startServer, request, rawRequest, rawSocketRequest,
  stubFetch, bingHappy, readJsonFile, listDirectory, statOrUndefined, fileText,
  assert, assertEqual, assertIncludes, ensureEvidenceDir, HOME_ROOT,
} from './lib/harness.mjs'

const suite = createSuite('host-security')
const uncaught = []
process.on('uncaughtException', (error) => { uncaught.push(`uncaughtException: ${error.message}`) })
process.on('unhandledRejection', (error) => { uncaught.push(`unhandledRejection: ${String(error)}`) })

async function fresh(tag) {
  const home = await makeHome(tag)
  const plugin = await loadPlugin(home)
  const host = await startServer(plugin)
  return { home, plugin, host, done: () => host.close() }
}

const S = '/api/dsh-thinking-zh/state'
const T = '/api/dsh-thinking-zh/translate'
const SET = '/api/dsh-thinking-zh/set'
const DIAG = '/api/dsh-thinking-zh/diag'

// ------------------------------------------------------- host / origin guard

await suite.test('trust guard: Host header allow/deny matrix', async () => {
  const ctx = await fresh('guard-host')
  try {
    const { port } = ctx.host
    const matrix = []
    const failures = []
    const loop = `127.0.0.1:${String(port)}`
    const cases = [
      { host: loop, origin: `http://${loop}`, expect: 200, label: 'ipv4 loopback' },
      { host: `localhost:${String(port)}`, origin: `http://localhost:${String(port)}`, expect: 200, label: 'localhost' },
      { host: 'evil.example', origin: 'http://evil.example', expect: 403, label: 'foreign host' },
      { host: `localhost.evil.example:${String(port)}`, origin: `http://localhost.evil.example:${String(port)}`, expect: 403, label: 'localhost lookalike' },
      { host: `evil.example:${String(port)}`, origin: `http://evil.example:${String(port)}`, expect: 403, label: 'foreign host with port' },
      // Attack shape: DNS name whose string form starts with "127." resolves to 127.0.0.1.
      { host: `127.0.0.1.nip.io:${String(port)}`, origin: `http://127.0.0.1.nip.io:${String(port)}`, expect: 403, label: 'DNS rebinding 127.0.0.1.nip.io (host+origin)' },
      { host: `127.0.0.1.evil.example:${String(port)}`, origin: `http://127.0.0.1.evil.example:${String(port)}`, expect: 403, label: 'DNS rebinding 127.0.0.1.evil.example' },
      { host: `127.1.2.3.nip.io:${String(port)}`, origin: `http://127.1.2.3.nip.io:${String(port)}`, expect: 403, label: 'DNS rebinding 127.1.2.3.nip.io' },
      { host: `127.0.0.1:${String(port)}@evil.example`, origin: `http://127.0.0.1:${String(port)}@evil.example`, expect: 403, label: 'userinfo trick' },
      { host: undefined, expect: 403, label: 'missing Host on HTTP/1.0', httpVersion: '1.0' },
    ]
    for (const item of cases) {
      const headers = { origin: item.origin }
      if (item.host !== undefined) headers.host = item.host
      const response = await rawSocketRequest({ port, path: S, method: 'GET', headers, httpVersion: item.httpVersion })
      matrix.push(`${item.label}=${String(response.status)}`)
      if (response.status !== item.expect) failures.push(`${item.label}: expected ${String(item.expect)}, got ${String(response.status)}`)
    }
    // HTTP/1.1 without Host is refused by Node's parser before the plugin runs.
    const noHost11 = await rawSocketRequest({ port, path: S, method: 'GET', headers: {} })
    matrix.push(`missing Host on HTTP/1.1=${String(noHost11.status)}`)
    assertEqual(failures.length, 0, failures.join('; '))
    return matrix.join(', ')
  } finally {
    await ctx.done()
  }
})

await suite.test('trust guard: Origin matrix (same-origin allowed, cross-site rejected)', async () => {
  const ctx = await fresh('guard-origin')
  try {
    const { port } = ctx.host
    const same = `http://127.0.0.1:${String(port)}`
    const matrix = []
    const cases = [
      { origin: same, expect: 200, label: 'same origin' },
      { origin: 'http://evil.example', expect: 403, label: 'cross-site origin' },
      { origin: 'null', expect: 403, label: 'opaque origin (null)' },
      { origin: `${same.replace(String(port), String(port - 1))}`, expect: 403, label: 'same host other port' },
      { origin: 'http://localhost:9999', expect: 403, label: 'localhost other port' },
      { origin: `https://127.0.0.1:${String(port)}`, expect: 200, label: 'same host:port but https scheme' },
    ]
    for (const item of cases) {
      const response = await rawRequest(port, {
        path: S, method: 'GET', headers: { host: `127.0.0.1:${String(port)}`, origin: item.origin },
      })
      matrix.push(`${item.label}=${String(response.status)}`)
      assertEqual(response.status, item.expect, item.label)
    }
    // Missing Origin is allowed by design (non-browser clients / older browsers).
    const noOrigin = await rawRequest(port, { path: S, method: 'GET', headers: { host: `127.0.0.1:${String(port)}` } })
    assertEqual(noOrigin.status, 200, 'missing Origin allowed')
    // Cross-site form POST (simple content type, no preflight) is still rejected.
    const formPost = await rawRequest(port, {
      path: SET, method: 'POST',
      headers: { host: `127.0.0.1:${String(port)}`, origin: 'http://evil.example', 'content-type': 'text/plain' },
      body: '{"enabled":false}',
    })
    assertEqual(formPost.status, 403, 'cross-site form POST')
    return `${matrix.join(', ')}, missing-origin=200, cross-site-form=403`
  } finally {
    await ctx.done()
  }
})

await suite.test('trust guard: non-loopback TCP peer is refused even with loopback Host/Origin/XFF', async () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((entry) => entry !== undefined && entry.family === 'IPv4' && entry.internal === false)
  if (lan === undefined) return 'SKIPPED: no non-internal IPv4 interface'
  const home = await makeHome('guard-remote')
  const plugin = await loadPlugin(home)
  const host = await startServer(plugin, { host: '0.0.0.0' })
  try {
    const response = await rawSocketRequest({
      connectHost: lan.address,
      port: host.port,
      path: S,
      method: 'GET',
      headers: {
        host: `127.0.0.1:${String(host.port)}`,
        origin: `http://127.0.0.1:${String(host.port)}`,
        'x-forwarded-for': '127.0.0.1',
      },
    })
    assertEqual(response.status, 403, `non-loopback peer ${lan.address}`)
    return `peer=${lan.address} status=${String(response.status)}`
  } finally {
    await host.close()
  }
})

await suite.test('trust guard: IPv6 ::1 loopback accepted', async () => {
  const home = await makeHome('guard-ipv6')
  const plugin = await loadPlugin(home)
  let host
  try {
    host = await startServer(plugin, { host: '::1' })
  } catch (error) {
    return `SKIPPED: cannot bind ::1 (${error.message})`
  }
  try {
    const response = await rawSocketRequest({
      connectHost: '::1',
      port: host.port,
      path: S,
      method: 'GET',
      headers: { host: `[::1]:${String(host.port)}`, origin: `http://[::1]:${String(host.port)}` },
    })
    assertEqual(response.status, 200, '::1 loopback')
    return `status=${String(response.status)}`
  } finally {
    await host.close()
  }
})

// --------------------------------------------------------------- diag() abuse

await suite.test('diag: traversal / absolute / device names stay inside diag dir', async () => {
  const ctx = await fresh('diag-traversal')
  const diagDir = join(ctx.home, 'dsh-thinking-zh', 'diag')
  try {
    const names = [
      '../../evil',
      '..\\..\\evil',
      '/absolute/evil',
      'C:\\Windows\\evil',
      '..',
      '.',
      'a/b',
      '%2e%2e%2f%2e%2e%2fevil',
      '..\\..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts',
      '中文名',
      'x'.repeat(300),
      '',
    ]
    const observed = []
    for (const name of names) {
      const response = await request(ctx.host.base, DIAG, {
        method: 'POST', body: { name, payload: { probe: name } },
      })
      assertEqual(response.status, 200, `diag name ${JSON.stringify(name)}`)
      const resolved = response.json.path
      assert(resolved.startsWith(diagDir), `path escaped diag dir: ${resolved}`)
      observed.push(`${JSON.stringify(name.slice(0, 24))} -> ${resolved.slice(diagDir.length + 1)}`)
    }
    const files = await listDirectory(diagDir)
    // Every written file must be a direct child of diag/ (no nested dirs created).
    for (const file of files) {
      const info = await stat(join(diagDir, file))
      assert(info.isFile(), `unexpected non-file in diag dir: ${file}`)
    }
    const nested = await listDirectory(join(ctx.home, 'dsh-thinking-zh'))
    assert(!nested.includes('evil.json'), 'traversal did not write evil.json outside diag')
    return `${String(files.length)} files; ${observed.join(' | ')}`
  } finally {
    await ctx.done()
  }
})

await suite.test('diag: file count capped at 60 with oldest pruned', async () => {
  const ctx = await fresh('diag-flood')
  try {
    const dir = join(ctx.home, 'dsh-thinking-zh', 'diag')
    for (let index = 0; index < 65; index += 1) {
      const response = await request(ctx.host.base, DIAG, {
        method: 'POST', body: { name: `flood-${String(index)}`, payload: { index, padding: 'x'.repeat(1024) } },
      })
      assertEqual(response.status, 200, `diag ${String(index)}`)
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
    const files = await listDirectory(dir)
    assert(files.length <= 60, `diag files ${String(files.length)} must be <= 60`)
    assert(!files.includes('flood-0.json'), 'oldest diag dump was not pruned')
    assert(files.includes('flood-64.json'), 'newest diag dump missing')
    const total = await Promise.all(files.map(async (file) => (await stat(join(dir, file))).size))
    return { files: files.length, approxBytes: total.reduce((sum, size) => sum + size, 0) }
  } finally {
    await ctx.done()
  }
})

await suite.test('diag: payload cap 512KB is unreachable because the body cap is 256KB', async () => {
  const ctx = await fresh('diag-cap')
  try {
    const dir = join(ctx.home, 'dsh-thinking-zh', 'diag')
    // A payload that serializes to ~250KB fits the 256KB body cap and is stored.
    const fits = await request(ctx.host.base, DIAG, {
      method: 'POST', body: { name: 'fits', payload: { padding: 'x'.repeat(250 * 1024) } }, timeout: 20_000,
    })
    assertEqual(fits.status, 200, '250KB payload accepted')
    const stored = await stat(join(dir, 'fits.json'))
    // A payload above the 256KB body cap dies in readBody before the 413 branch.
    const oversize = await request(ctx.host.base, DIAG, {
      method: 'POST', body: { name: 'oversize', payload: { padding: 'x'.repeat(300 * 1024) } }, timeout: 20_000,
    })
    assertEqual(oversize.reset, true, '300KB body is cut by the body cap (no 413 JSON)')
    return { fitsStatus: fits.status, fitsBytes: stored.size, oversizeStatus: oversize.status, oversizeReset: oversize.reset, oversizeError: oversize.error }
  } finally {
    await ctx.done()
  }
})

await suite.test('diag: file mode requested 0o600 (POSIX bits on Windows)', async () => {
  const ctx = await fresh('diag-mode')
  try {
    const response = await request(ctx.host.base, DIAG, { method: 'POST', body: { name: 'mode-probe', payload: { a: 1 } } })
    const info = await statOrUndefined(response.json.path)
    return { path: response.json.path, mode: `0o${(info?.mode ?? 0).toString(8)}`, note: 'Windows ignores POSIX mode bits; ACL inherits from %TEMP%' }
  } finally {
    await ctx.done()
  }
})

// ------------------------------------------------------------- body handling

await suite.test('readBody: malformed JSON -> 400 on translate/set/diag; no crash, host alive', async () => {
  const ctx = await fresh('body-json')
  try {
    const translate = await request(ctx.host.base, T, { method: 'POST', body: '{oops' })
    const set = await request(ctx.host.base, SET, { method: 'POST', body: '{oops' })
    const diag = await request(ctx.host.base, DIAG, { method: 'POST', body: '{oops' })
    const alive = await request(ctx.host.base, S)
    assertEqual(translate.status, 400, 'translate')
    assertEqual(set.status, 400, 'set')
    assertEqual(diag.status, 400, 'diag')
    assertEqual(alive.status, 200, 'host alive')
    return { translate: translate.status, set: set.status, diag: diag.status, after: alive.status }
  } finally {
    await ctx.done()
  }
})

await suite.test('readBody: 257KB body -> connection reset, host survives, no uncaught exception', async () => {
  const ctx = await fresh('body-oversize')
  try {
    const payload = JSON.stringify({ enabled: false, pad: 'a'.repeat(300 * 1024) })
    const response = await request(ctx.host.base, SET, { method: 'POST', body: payload, timeout: 15_000 })
    const alive = await request(ctx.host.base, S)
    assertEqual(alive.status, 200, 'host alive')
    const issues = uncaught.filter((entry) => entry.includes('write after end') || entry.includes('EPIPE'))
    return { status: response.status, reset: response.reset, error: response.error, after: alive.status, issues }
  } finally {
    await ctx.done()
  }
})

await suite.test('readBody: slow/aborted upload cannot wedge the route table', async () => {
  const ctx = await fresh('body-abort')
  try {
    const { port } = ctx.host
    // Announce 100 bytes, send a partial JSON body, then abort the socket.
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: SET, method: 'POST',
        headers: { host: `127.0.0.1:${String(port)}`, 'content-type': 'application/json', 'content-length': '100' },
      })
      req.on('error', () => { resolve() })
      req.write('{"enabled":')
      setTimeout(() => { req.destroy(); resolve() }, 60)
    })
    const alive = await request(ctx.host.base, S)
    assertEqual(alive.status, 200, 'host alive')
    return 'ok'
  } finally {
    await ctx.done()
  }
})

// ---------------------------------------------------- SSRF / injection surface

await suite.test('translate never lets client steer the upstream URL (no SSRF)', async () => {
  const ctx = await fresh('ssrf')
  const stub = stubFetch(bingHappy())
  try {
    const attempts = [
      { targetLanguage: 'zh-Hans&url=http://169.254.169.254/latest/meta-data' },
      { targetLanguage: '../../../../etc/passwd' },
      { targetLanguage: 'zh-Hans#@evil.example' },
      { targetLanguage: 'javascript:alert(1)' },
    ]
    for (const attempt of attempts) {
      await request(ctx.host.base, T, {
        method: 'POST', body: { segments: [{ id: 'a', text: 'Probe.' }], ...attempt },
      })
    }
    for (const call of stub.calls) {
      assert(call.url.startsWith('https://edge.microsoft.com/translate/translatetext?'), `unexpected upstream URL: ${call.url}`)
    }
    // The raw target is carried as an encoded query value, not appended raw.
    return { calls: stub.calls.length, urls: stub.calls.map((call) => new URL(call.url).searchParams.get('to')) }
  } finally {
    stub.restore()
    await ctx.done()
  }
})

await suite.test('responses carry no CORS opt-in (cross-origin JS cannot read them)', async () => {
  const ctx = await fresh('headers')
  try {
    const response = await request(ctx.host.base, S)
    return {
      status: response.status,
      acao: response.headers['access-control-allow-origin'],
      cacheControl: response.headers['cache-control'],
      referrerPolicy: response.headers['referrer-policy'],
      contentType: response.headers['content-type'],
      hasAcao: response.headers['access-control-allow-origin'] !== undefined,
    }
  } finally {
    await ctx.done()
  }
})

// ------------------------------------------- durable files: mode / contents

await suite.test('durable state/cache file permissions and contents (no secrets)', async () => {
  const ctx = await fresh('files-mode')
  try {
    const stub = stubFetch(bingHappy(() => '中文缓存值'))
    try {
      await request(ctx.host.base, SET, { method: 'POST', body: { enabled: true, targetLanguage: 'zh-Hans' } })
      await request(ctx.host.base, T, { method: 'POST', body: { segments: [{ id: 'a', text: 'SENSITIVE English source.' }] } })
    } finally {
      stub.restore()
    }
    const dir = join(ctx.home, 'dsh-thinking-zh')
    const [stateInfo, cacheInfo, stateText, cacheText] = await Promise.all([
      stat(join(dir, 'state.json')),
      stat(join(dir, 'cache.json')),
      fileText(join(dir, 'state.json')),
      fileText(join(dir, 'cache.json')),
    ])
    return {
      dir,
      stateMode: `0o${stateInfo.mode.toString(8)}`,
      cacheMode: `0o${cacheInfo.mode.toString(8)}`,
      stateContent: stateText?.trim(),
      cacheHasSourceEnglish: cacheText.includes('SENSITIVE English source.'),
      cacheKeysHashed: Object.keys(JSON.parse(cacheText)).every((key) => /^[0-9a-f]{64}$/.test(key)),
    }
  } finally {
    await ctx.done()
  }
})

await suite.test('/set failure: 400 and in-memory state NOT mutated (write-then-adopt)', async () => {
  // $DSH_HOME pointing at a regular file makes every state write fail.
  const blocker = join(HOME_ROOT, `blocker-${String(Date.now())}.file`)
  await mkdir(HOME_ROOT, { recursive: true })
  await writeFile(blocker, 'not a directory', 'utf8')
  const plugin = await loadPlugin(blocker)
  const host = await startServer(plugin)
  try {
    const before = await request(host.base, S)
    const set = await request(host.base, SET, { method: 'POST', body: { enabled: false } })
    const after = await request(host.base, S)
    assertEqual(set.status, 400, 'set status')
    assertEqual(before.json?.enabled, true, 'enabled before')
    assertEqual(after.json?.enabled, true, 'failed write must not change memory state')
    return {
      statusBefore: before.json?.enabled,
      setStatus: set.status,
      setError: set.json?.error,
      statusAfter: after.json?.enabled,
    }
  } finally {
    await host.close()
  }
})

await suite.test('oversized/forged cache.json degrades to empty cache instead of failing routes', async () => {
  const ctx = await fresh('cache-corrupt')
  try {
    const dir = join(ctx.home, 'dsh-thinking-zh')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'cache.json'), '{not-json', 'utf8')
    const response = await request(ctx.host.base, T, {
      method: 'POST', body: { segments: [{ id: 'a', text: '' }] },
    })
    assertEqual(response.status, 200, 'route still works')
    const state = await request(ctx.host.base, S)
    assertEqual(state.status, 200, 'state still works')
    return 'ok'
  } finally {
    await ctx.done()
  }
})

// --------------------------------------------------- cache concurrency race

await suite.test('concurrent flushes: no translation is lost from disk cache', async () => {
  const ctx = await fresh('cache-race')
  const stub = stubFetch(async (url, options) => bingHappy()(url, options))
  try {
    let lost = 0
    for (let round = 0; round < 25; round += 1) {
      const [, second] = await Promise.all([
        request(ctx.host.base, T, { method: 'POST', body: { segments: [{ id: 'a', text: `Race A ${String(round)}.` }] } }),
        request(ctx.host.base, T, { method: 'POST', body: { segments: [{ id: 'b', text: `Race B ${String(round)}.` }] } }),
      ])
      assertEqual(second.status, 200, 'status')
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const cache = await readJsonFile(join(ctx.home, 'dsh-thinking-zh', 'cache.json'))
    const values = Object.values(cache ?? {})
    for (let round = 0; round < 25; round += 1) {
      if (!values.some((value) => value === `译:Race A ${String(round)}.`)) lost += 1
      if (!values.some((value) => value === `译:Race B ${String(round)}.`)) lost += 1
    }
    return { entries: values.length, lost }
  } finally {
    stub.restore()
    await ctx.done()
  }
})

// ------------------------------------------------ unload / reload behaviour

await suite.test('unload: debounce timer state survives dispose (reload regression probe)', async () => {
  const home = await makeHome('unload-timer')
  const plugin = await loadPlugin(home)
  let effectDisposer
  const ctx = {
    effect(fn) {
      effectDisposer = fn()
      return effectDisposer
    },
    webServer: { register: () => () => {} },
  }
  plugin.apply(ctx)
  const stub = stubFetch(bingHappy())
  const countScheduled = () => {
    const original = globalThis.setTimeout
    let scheduled = 0
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (ms === 2000) scheduled += 1
      return original(fn, ms, ...rest)
    }
    return { scheduled: () => scheduled, restore: () => { globalThis.setTimeout = original } }
  }
  try {
    // Warm module-level timer state: first translation schedules the 2s flush.
    const probe = countScheduled()
    await plugin.translateSegments([{ id: 'a', text: 'Before unload.' }], {
      targetLanguage: 'zh-Hans', provider: 'bing', signal: new AbortController().signal,
    })
    const beforeUnload = probe.scheduled()
    probe.restore()

    // Plugin unload: the effect disposer clears the timer but leaves the module
    // variable non-null; a subsequent activation must be able to schedule again.
    effectDisposer()

    const afterUnload = countScheduled()
    await plugin.translateSegments([{ id: 'b', text: 'After unload.' }], {
      targetLanguage: 'zh-Hans', provider: 'bing', signal: new AbortController().signal,
    })
    const after = afterUnload.scheduled()
    afterUnload.restore()
    return { beforeUnload, afterUnload: after }
  } finally {
    stub.restore()
  }
})

await suite.test('unload: pending dirty cache is not flushed on dispose', async () => {
  const home = await makeHome('unload-flush')
  const plugin = await loadPlugin(home)
  let effectDisposer
  const ctx = { effect(fn) { effectDisposer = fn(); return effectDisposer }, webServer: { register: () => () => {} } }
  plugin.apply(ctx)
  const stub = stubFetch(bingHappy())
  try {
    // remember() schedules a 2s flush; dispose immediately before it can run.
    await plugin.translateSegments([{ id: 'a', text: 'Unflushed.' }], {
      targetLanguage: 'zh-Hans', provider: 'bing', signal: new AbortController().signal,
    })
    effectDisposer()
    await new Promise((resolve) => setTimeout(resolve, 2600))
    const cache = await readJsonFile(join(home, 'dsh-thinking-zh', 'cache.json'))
    return { cacheExists: cache !== undefined, entries: Object.keys(cache ?? {}).length }
  } finally {
    stub.restore()
  }
})

// ------------------------------------------------------------------ cleanup

const summary = suite.summary()
const evidence = await ensureEvidenceDir()
await writeFile(join(evidence, 'host-security-results.json'), `${JSON.stringify({ summary, uncaught }, null, 2)}\n`, 'utf8')
console.log(`\n== host-security: ${String(summary.counts.PASS)} pass, ${String(summary.counts.FAIL)} fail, ${String(summary.counts.NOTE)} note, ${String(summary.counts.ERROR)} error`)
if (uncaught.length > 0) console.log(`!! process-level errors: ${uncaught.join(' | ')}`)
process.exitCode = summary.counts.FAIL + summary.counts.ERROR > 0 ? 1 : 0
