import { loadPlugin, makeHome } from "./harness.mjs"
import { EventEmitter } from "node:events"
const home = await makeHome("guard-unit")
const plugin = await loadPlugin(home)
const route = plugin.makeRoutes().find((r) => r.path.endsWith("/state"))
async function probe(headers, remoteAddress = "127.0.0.1") {
  const req = new EventEmitter()
  req.socket = { remoteAddress }
  req.headers = headers
  req.method = "GET"
  let status = 0, body = ""
  const res = { writeHead(s) { status = s }, end(t) { body = t } }
  const result = route.handler(req, res)
  await Promise.race([result, new Promise((r) => setTimeout(r, 500))])
  return { status, body: String(body).slice(0, 80) }
}
const cases = [
  { host: "127.0.0.1:61203", origin: "http://127.0.0.1:61203" },
  { host: "127.0.0.1.nip.io:61203", origin: "http://127.0.0.1.nip.io:61203" },
  { host: "127.0.0.1.nip.io:61203", origin: "http://127.0.0.1:61203" },
  { host: "127.0.0.1.nip.io:61203" },
  { host: "127.0.0.1.evil.example:61203", origin: "http://127.0.0.1.evil.example:61203" },
  { host: "127.1.2.3.nip.io:61203", origin: "http://127.1.2.3.nip.io:61203" },
]
for (const c of cases) console.log(JSON.stringify(c), "=>", JSON.stringify(await probe(c)))
