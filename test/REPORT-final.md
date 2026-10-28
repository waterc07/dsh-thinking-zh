# dsh-thinking-zh — 交付报告

日期：2026-10-22 · 目标 DSH：`0.2.1-rc.2`（Desktop，profile `desktop`）

## 1. 问题

DSH 的思考过程在**折叠状态**只显示一行英文预览。DSH 自带的
`@deepseek-ai/dsh-experimental-cot-translation-bundle` 只翻译**展开后**的正文
（其 README 明确写着「折叠的预览保留原文」），所以日常浏览时看到的那一行永远是英文。

本插件补的就是这一行。

## 2. 做了什么

| 层 | 文件 | 职责 |
|---|---|---|
| 宿主 | `src/index.js` (19.8 KiB) | `/translate`、`/state`、`/set`、`/diag` 四个 loopback 路由；Edge/Bing 匿名翻译；内存 LRU + 磁盘缓存（5000 条上限、sha256 键）；原子写 |
| 浏览器 | `src/client.js` (32.6 KiB) | `MutationObserver` 找折叠思考预览 → 400ms 独立稳定性时钟 → 批量翻译 → **只改文本节点与属性**写回中文 |
| 装配 | `cordis.patch.yml`、`scripts/install.mjs`、`scripts/build.mjs` | 把插件作为最高优先级 bundle 层插入 profile |

DOM 钩子（不依赖 CSS-module 哈希）：

```
div[data-variant="think"][data-preview]:not([data-expanded])
  → [data-shimmer-decoration] + span        // 该行唯一文本节点
```

原文不丢：被替换节点保留 `title` 与 `data-dsh-thinking-zh-original`，悬停可看英文。
展开后的正文仍由内置 `cot-translation` 负责，两者互不干扰（本插件用 `:not([data-expanded])` 主动让位）。

## 3. 验证

### 3.1 宿主半（自动化，可复跑）
```
node test/host-functional.test.mjs   → 31 pass, 0 fail
node test/host-security.test.mjs     → 18 pass, 0 fail
```
覆盖：真实 Bing 往返、缓存命中/批量/去重、8 段与 4000 字符边界、超时与上游 500 的**逐段降级**、
`enabled=false` 短路、缓存跨重载持久化与 5000 条淘汰、原子写、
loopback+Host+Origin 信任矩阵（含 `127.0.0.1.nip.io` 等 DNS-rebinding 形态 → 403）、
`diag` 路径穿越、无 SSRF、无 CORS 放行、body 上限。

> 审查中修掉的真实缺陷：`127.0.0.1.nip.io` 这类"解析到 loopback 的名字"曾通过 Host 校验；
> 现改为只接受 `localhost`、IPv6 `::1`、真正的 127.0.0.0/8 点分四段地址。

### 3.2 浏览器半（实验实例 + 真实应用）
- 独立 `zhdev` profile 实例（`dsh web --port 5599`）中跑通：英文稳定 → 中文 **407 / 410 / 449 ms**
  （首轮冷 TLS 896ms，已用一次预热消除）；React 重渲染覆盖后从缓存零请求恢复。
- 独立验证者（red team）复跑：**有条件通过，必须修：无**。复核哈希
  client `D90D97F2…E7AC` / host `C7DA6A3B…DC73`，`src` 与 `lib` 一致；
  host 独立复跑 functional 31/31、security 19/19。
- 截图证据（`test/evidence/`）：
  - `10-preview-chinese.png` — 流式进行中，折叠预览已是中文
  - `11-collapsed-chinese.png` — 回复结束后展开「已完成」过程组，折叠思考行预览为中文
  - `12-expanded.png` — 展开后正文仍是完整英文原文（内置行为未被破坏）
  - `e2e-collapsed-preview{,2}.png` — 折叠思考行中文 + `title` 英文
  - `e2e-expanded-row.png` — 展开后完整英文推理正文
  - `e2e-hot-reload.png` — reload 后 5 行预览从磁盘缓存恢复中文，translate 1–2ms、无上游
  - `e2e-provider-failure.png` / `e2e-recovered.png` — provider 故障降级保英文，改回后 5/5 恢复
  - `e2e-second-session.png` / `e2e-back-to-first.png` — 新建/切回会话 488ms 内 5/5 恢复
- 行为结论（验证者实测）：`enabled=false` 5.4s 内恢复英文、0 残留；切换会话/展开折叠/滚动后
  计数稳定、`translateCallsAdded=0`；clean tab console 0 error/0 warning；原文 `title` 一致。

### 3.3 真实桌面应用（最终验收）
插件装进用户 `desktop` profile 并重启应用后实测：

- 展开「已完成分析」→ 折叠思考行显示：
  > 思考 · 用户需要一个能将英语思维/推理过程翻译成中文的插件。这是关于 DeepSeek Harness（DSH）本身——DSH 网页图形界面的一个插件，可以将英文推理轨迹翻译成中文。
- 宿主缓存里本轮 3/3 条英文预览都有对应中文（`cache.json` 命中）。
- 页面首屏诊断：109 个 think 行全部命中预览选择器，0 失败。

## 4. 安装状态 / 回滚

已装入 `$DSH_HOME\profiles\desktop`：
`dependencies` 增加 `link:../../plugins/dsh-thinking-zh`，`dsh.profile.bundles` 末尾追加，
并建好 `node_modules\dsh-thinking-zh` junction；`pnpm-lock.yaml` 已按同样格式补条目。
改动前的清单备份：`package.json.bak-dsh-thinking-zh-*`。

回滚：
```powershell
$env:DSH_DESKTOP_NODE_EXECUTABLE="$env:DSH_INSTALL\DeepSeek Harness.exe"
& "$env:DSH_INSTALL\resources\runtime\bin\node.cmd" scripts\install.mjs --profile desktop --uninstall
# 然后重启 DSH
```

## 5. 已知限制

1. **延迟**：热路径 ~0.4s；首次冷启动 ~0.9s（匿名端点 TLS）。流式期间最后一段会等文本稳定后才翻。
2. **翻译质量**：匿名机器翻译，术语可能走样（例如把 `asar` 译成"阿萨尔"、把 "Chinese replacement" 译成"中国替代品"）。
   需要更高保真时，可把 provider 换成付费 DeepSeek 路由（内置 translator 已支持 `deepseek-official`）。
3. **覆盖范围**：只翻折叠预览。展开后的正文由 DSH 内置插件负责；两者语言可能不同步（内置默认译文视图）。
4. **失败降级**：上游不可用时保留英文、不重试、不切换 provider；缓存命中则完全离线可用。
5. **隐私**：翻译会把预览文本发给 Microsoft 的边缘翻译端点（与 DSH 内置插件默认行为一致）；
   本地缓存键为 sha256、值为中文译文，位于 `$DSH_HOME\dsh-thinking-zh\`。
6. 一天内多开多个页面会各自观察 DOM，但磁盘缓存保证同一句只请求一次。

### 5.1 验证者提出的两项非阻塞待办（不影响当前使用）

- **开关生效靠轮询**：`enabled` 状态每 20s 轮询一次，实测禁用后 5.4s 恢复英文，与契约的"立即"有偏差。
  待办：`/set` 后让客户端主动拉取一次（或改成一次性事件），而不是等轮询。
- **流式期间翻译中间态**：每轮约 2–3 次上游请求会带上尚未写完的推理片段。
  待办：等 `data-streaming` 消失后再入队，可进一步降低请求量与外发文本量（代价是末尾延迟略增）。

## 6. 文件

```
$PLUGIN_DIR\
├─ src/index.js  src/client.js          # 源码（冻结版本）
├─ lib/index.js  lib/client.js          # 构建产物（src 的直接拷贝）
├─ scripts/build.mjs  scripts/install.mjs
├─ cordis.patch.yml  package.json  README.md
└─ test/  ├─ CONTRACT.md  REPORT-client.md
         ├─ host-functional.test.mjs  host-security.test.mjs  lib/harness.mjs
         └─ evidence/  (截图 + 测试结果 JSON)
```
