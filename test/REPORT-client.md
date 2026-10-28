# dsh-thinking-zh — 浏览器半（client）最终报告

负责人：teammate `client-preview`
状态：**代码已冻结**（`src/client.js` / `lib/client.js` 不再改动）
验证环境：zhdev 实验 profile，端口 5599（已 kill），DeepSeek-V4.1-Flash / High / 标准模式

---

## 1. 产物与哈希

| 文件 | 大小 | SHA-256 |
| --- | --- | --- |
| `src/client.js` | 33,393 B | `D90D97F2AE49D6EEC2D373DC6F459FE34FDE890A75DCDA80370F1FEE40C4E7AC` |
| `lib/client.js` | 33,393 B | `D90D97F2AE49D6EEC2D373DC6F459FE34FDE890A75DCDA80370F1FEE40C4E7AC` |

两者**内容完全一致**（sha256 相同），由 `node scripts/build.mjs` 从 `src/` 直接复制生成，无打包/转译。

发布形式（契约要求）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-thinking-zh',
  factory: (require) => { /* exports.apply = apply; exports.inject = inject */ },
})
```

`inject = []`（纯 DOM + 同源 fetch，不需要客户端服务）。`apply(ctx)` 兼容 `ctx.effect()` 做生命周期清理，并自动回收上一实例（热重载）。

---

## 2. 最终选择器与它为什么稳定

```text
行（collapsed + 正在显示预览）：
  div[data-variant="think"][data-preview]:not([data-expanded])
预览元素：
  ... [data-shimmer-decoration] + span      （分隔点的下一个兄弟 = summary span）
回退：
  ... [data-streaming]
文本节点：
  summary span 下的第一个非空 text node（TextShimmer 内层是单个文本节点）
```

**依赖的全是语义属性，不是 CSS-module 哈希：**

| 属性 | 含义 | 来源 |
| --- | --- | --- |
| `data-variant="think"` | 该行是 assistant 推理 disclosure | `ReasoningRow` 的 React props 直接落到 DOM |
| `data-expanded` | 推理行是否展开 | 同一组件 |
| `data-preview` | 折叠预览当前是否显示（`!expanded && summary !== '' && (running \|\| settledReasoningPreview)`） | 同一组件 |
| `data-shimmer-decoration` | 预览前的 2px 分隔点（纯装饰，`aria-hidden`） | 同一组件 |
| `data-streaming` | 预览正在跟随流式文本 | 同一组件 |

这些属性在 `@deepseek-ai/dsh-client-ui-chat` 的 `ReasoningRow` 里作为 JSX 属性写死（构建产物 `lib/client.js` 第 6164–6217 行可核对），不随 CSS-module 构建哈希（如 `_3GBCTG_root`）变化；即使上游改样式类名，选择器仍然命中。真正的兜底是 `/diag`：如果上游把 `data-*` 也改掉，`no-think-rows.json` 会带上整页 DOM 结构，可立即重定选择器。

**DOM 写入边界**：只写 `textNode.nodeValue` 与元素属性（`title`、`data-dsh-thinking-zh-original/-translation/-state`）；**不插入/删除元素、不改 `innerHTML`**，不和 React reconciler 抢结构。

---

## 3. 行为与延迟

### 流程
1. `MutationObserver(document.body, {childList, subtree, characterData})` → 用 `requestAnimationFrame` 合并 → `scan()`。
2. `scan()` 读取每个折叠预览的当前文本；对新出现的文本**立刻 prefetch** 翻译请求（每批 ≤8 段，符合 host 契约），同时给该字符串起一个**独立稳定性时钟**。
3. 某字符串 400ms 内未再变化 → `pass()` 把翻译写回它的文本节点（英文原文存入 `title` + `data-dsh-thinking-zh-original`）。
4. 批处理最多 8 段/请求；host 内存 LRU + 磁盘缓存负责去重，重复文本不再走网络。

### 关键修复：不能用「全页 400ms 防抖」
第一版用页面级防抖：回答正文流式输出时每 ~20ms 就有 mutation，防抖被无限重置，导致预览迟迟不翻译（实测 1037ms 且可能更久）。改为**按字符串的稳定性时钟**后，答案流式的 mutation 不再拖延预览。

### 延迟实测（真实页面，`performance.now()` 精确测量）
| 场景 | 「英文稳定 → 中文」 |
| --- | --- |
| 加预热前（首轮 TLS 冷启动，网络 896ms） | 890 / 1037 / 901 ms |
| 并行预取 + 页面加载预热后 | **407 / 410 / 449 ms** |
| 同一连接后续请求（网络段本身） | 250–310 ms |

所以延迟 ≈ `max(400ms 稳定性门槛, 翻译网络耗时)`。为消除“打开页面直接进新会话”时的冷 TLS，`apply()` 会发一次极小预热请求（`Ready.`，host 有缓存，每页加载最多一次）；`enabled=false` 时 host 直接返回空结果，不会打到上游。

### 已验证行为
- 流式期间折叠行预览即为中文（截图 10）。
- 完成后折叠行（展开「已完成」过程组后可见）预览为中文、`title` 为英文原文（截图 11 + `verify-report.json`）。
- 展开推理行：正文仍是完整英文原文，本插件不碰正文（截图 12）。
- `enabled=false`（POST `/set`）→ 立即停表并恢复英文（`restoreAll`）。
- 全部异常 `try/catch` 吞掉；整轮验证 `console/pageerror = []`。

---

## 4. React 重渲染覆盖后的重新应用

- 页面内维护 `translations: Map<英文, 中文>`（上限 400 条，LRU 语义）。
- React 因流式新段落 / 展开-折叠切换而重写 summary 文本节点后，observer → `scan()` 会看到“当前文本是英文、且 `translations` 里有它” → `pass()` 直接写回中文，**不产生网络请求**。
- 实证（插件自带事件日志）：`09:04:59.784 apply:ok "We need answer math…"` → `09:05:03.474` 同一原文再次 `apply:ok`，两者之间没有 `translate:ok`，即零请求恢复。
- 跨页面/重启恢复：host 磁盘缓存 `$DSH_HOME/dsh-thinking-zh/cache.json` 命中，重新打开已完成会话时 preview 直接应用（证据：重开会话后 `passes:1, translated:1, inflight:0`，无冷启动延迟）。

---

## 5. 跳过规则（不做翻译的文本）

- 长度 < 6 字符；
- 没有拉丁字母（纯数字 / 符号 / emoji / 已是中文）；
- 中文（CJK/假名/谚文）≥2 且占字母比例 > 25%；
- 纯 URL（`http(s)://`、`ftp://`、`www.`）；
- 以 `` ` ``、`$`、`>`、`#` 开头的代码/提示符；
- 常见 shell 命令前缀（`git`、`npm`、`pnpm`、`node`、`cd`、`ls`、`curl`、`sudo`、`python`、`pwsh`…）；
- 无空格且只含 `[\w./\\:@~%+=-]` 的单 token（路径 / 标识符 / 文件名）；
- markdown 表格行 / 以 `|` `` ` `` `{` `}` `<` `>` 开头的代码行。

`<code>` / `<pre>` 内文本不会被选中：目标选择器只落在 `[data-variant="think"]` 的折叠预览 span 上，正文与代码块不在候选范围内。

---

## 6. 已知限制

1. **标准模式（默认）下，一轮结束后内置 `foldCompletedTurns` 会把整段 process 折叠隐藏**，此时折叠预览本身不可见；用户点开「已完成」过程组后才看到（我们验证的截图 11 就是这个操作之后的画面）。这是内置折叠行为，不是插件能改的结构；插件保证的是「只要该行在显示 preview，它就是中文且文本稳定后 <1s 更新」。流式/推理进行中该行可见且已中文（截图 10）。
2. 400ms 稳定性门槛按契约保留：存活时间 <400ms 的瞬时预览文本不会被翻译（只翻译最终稳定下来的文本），避免无意义的请求与闪烁。
3. 网络失败/超时：该字符串进入 failed（60s TTL），期间保持英文，不重试风暴、不影响页面；单批中某段失败只降级该段（host 契约：`text: null`）。
4. 跳过规则可能误跳过「只有一个英文单词」的预览（如 `Inspecting`）；这是为避开 URL/命令/路径做的保守取舍。
5. 选择器绑定在 DSH 当前的 `data-*` DOM 契约上；上游若改成纯 class 结构需更新选择器（`/diag` 的 `no-think-rows.json` 会记录整页结构，便于快速修复）。
6. 本 profile 未启用内置 `cot-translation`（`data-cot-translation` 节点数 = 0），因此“展开正文由内置翻译接管”这条只验证了**不破坏**（正文英文原文完整、本插件不写正文），未验证两者叠加效果。
7. 翻译的是整行预览文本（视觉上仍是 nowrap + ellipsis，与内置表现一致）；不做流式逐字翻译。
8. 页面加载会发 1 次极小预热请求；`enabled=false` 时不会打到上游。
9. `$DSH_HOME/sessions` 与真实环境共享：本次只**新建**测试会话，从未打开任何用户既有会话（Boom_Birds / 树莓派 等只出现在侧边栏列表里，未被点击）。

---

## 7. 证据（`test/evidence/`）

路径：`test\evidence\`

| 文件 | 内容 |
| --- | --- |
| `10-preview-chinese.png` | **流式进行中**：折叠的「思考」行预览已是中文，正文仍在输出 |
| `11-collapsed-chinese.png` | **回复结束后**：展开「已完成」过程组 → 折叠「思考」行预览为中文（`title` 保留英文原文）。这是核心验收截图 |
| `12-expanded.png` | 同一行**展开**后：正文是完整英文原文（内置行为未被破坏） |
| `verify-report.json` | 结构化证据：`exactLatencyMs=410`、`collapsed.summaryText`（中文）、`collapsed.summaryAttrs`（`title`/`data-dsh-thinking-zh-original` 英文）、`plugin status`、`consoleIssues: []`、页面内 preview 时间线 |
| `client-evidence-summary.json` | 哈希、选择器、延迟数字、会话列表的精简汇总 |

插件诊断产物（`/diag` 契约已保留在最终版本）：`$DSH_HOME\dsh-thinking-zh\diag\preview-dom.json`、`no-think-rows.json`。

---

## 8. 本次实验创建/触及的会话（供 Lead 清理）

只新建，未打开任何用户会话。zhdev 的默认工作区是 `Boom_Birds`，所以其中 5 个落在
`$DSH_HOME\sessions\<workspace-hash>\`，1 个落在
`$DSH_HOME\sessions\<workspace-hash-2>\`：

| 时间 | session 目录 | 标题（UI） |
| --- | --- | --- |
| 17:00 | `--wsl.localhost-Ubuntu-24.04-home--\session-60ea29b5-8d39-4778-8c74-7d750e8061d5` | Spanning trees of complete graph K6 |
| 17:02 | `--D-Users-Admin-Desktop-G-Master-Boom_Birds--\session-a2e515c4-a1d8-4c0d-9a32-0f178259a7aa` | Spanning trees of complete graph K6 |
| 17:03 | `...\session-737c2d99-9dc8-45f5-89f9-f811acf36ee1` | Spanning trees of complete graph K6 |
| 17:05 | `...\session-26264ad2-8a19-4f3d-9541-e519fb83644f` | Spanning trees of complete graph K6 |
| 17:06 | `...\session-898eb56f-8d9b-47cd-83f6-4c8cf6e2516f` | Number of spanning trees in K6 |
| 17:07 | `...\session-fba58e02-3a73-416f-bdd9-1213f2f21fbf` | Spanning trees of complete graph K6 |

---

## 9. 实验实例状态

- zhdev web 实例（端口 **5599**）已停止，端口确认释放；未触碰用户桌面 app（pid 41636）。
- 未修改 `$DSH_INSTALL\*`，未写入 `$DSH_HOME\profiles\desktop\`。
