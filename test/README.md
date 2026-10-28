# 测试与验证

本目录不是 `node:test` 套件，而是两个自带极简 runner 的独立脚本（`createSuite`，见
`lib/harness.mjs`）。它们在真实 `node:http` 服务器上挂载宿主半的路由，因此测的是
`src/index.js` 的真实行为，而不是 mock。

## 目录

| 路径 | 作用 |
| --- | --- |
| `host-functional.test.mjs` | 宿主半功能测试：翻译、缓存、去重、批处理、边界、失败降级、`/state`、`/set`、`/diag`、`apply()` 生命周期 |
| `host-security.test.mjs` | 宿主半安全测试：loopback + Host + Origin 信任矩阵、DNS rebinding、`/diag` 路径穿越、SSRF、body 上限、无 CORS |
| `lib/harness.mjs` | 测试脚手架：隔离的 `$DSH_HOME`、真实 HTTP 服务器、`fetch` 桩、断言与 runner |
| `lib/probe.mjs` | 手动探测信任守卫的小脚本（直接调用路由 handler，不起服务器） |
| `lib/pw-*.js` | 生成 `test/evidence/` 截图的 Playwright 片段（历史实验脚本，无统一 runner；截图路径相对仓库根目录） |
| `CONTRACT.md` | 宿主 ↔ 浏览器半的接口契约（选择器、路由、安全要求） |
| `REPORT-*.md` | 浏览器半 / 最终交付的验证报告 |
| `evidence/` | 截图与结构化测试证据（JSON） |

## 运行

在仓库根目录执行：

```powershell
node test/host-functional.test.mjs
node test/host-security.test.mjs
```

两个脚本都会把结果写入 `test/evidence/host-*-results.json`（会覆盖上一次的运行结果），
失败时退出码为 1。

### `host-functional` 与网络

只有第一个用例（`real Bing: ...`）会访问真实的匿名翻译端点，其余用例全部使用 `fetch`
桩，可完全离线运行。没有网络时用环境变量跳过它：

```powershell
$env:DSH_THINKING_ZH_OFFLINE = "1"
node test/host-functional.test.mjs
```

该用例会被记为 `NOTE`（`SKIPPED: DSH_THINKING_ZH_OFFLINE=1`），而不是 `PASS`，也不会
伪造翻译结果。

### 隔离的 `$DSH_HOME`

测试默认把 `$DSH_HOME` 指向系统临时目录下的 `zh-verify-home/`，不会读写真实的
`~/.dsh`。需要把临时状态留在仓库内（例如为了得到不含用户名的证据路径）时：

```powershell
$env:DSH_THINKING_ZH_TEST_HOME = "test/.tmp-home"
node test/host-security.test.mjs
```

`test/.tmp-home/` 已在 `.gitignore` 中忽略，跑完可以直接删除。

## 浏览器半

浏览器半没有可离线复跑的自动化测试：它依赖正在运行的 DSH Web 界面、Playwright 和真实
模型输出。`lib/pw-*.js` 是当时用于生成 `test/evidence/*.png` 的 Playwright 片段，只用于
复盘，不参与 `node` 测试；需要时自行用 Playwright 驱动一个已安装本插件的 DSH 实例执行。
