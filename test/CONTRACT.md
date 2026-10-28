# dsh-thinking-zh — 接口契约（Lead 锁定，勿单方面修改）

## 目标
在 DeepSeek Harness 的对话界面里，把**折叠状态的英文思考过程预览**（`已完成分析` / `正在分析请求` 下面那一行英文）
即时替换为中文。展开后的正文由 DSH 内置的 `cot-translation` 插件负责，本插件**不得与之冲突**。

## 目录
```
$PLUGIN_DIR\
  package.json          # 已由 Lead 创建，勿改（除必要 bug）
  cordis.patch.yml      # 已由 Lead 创建
  src/index.js          # 宿主半（T1 负责）
  src/client.js         # 浏览器半（T2 负责）
  lib/index.js          # src/index.js 的构建产物（scripts/build.mjs 复制）
  lib/client.js         # src/client.js 的构建产物
  scripts/build.mjs     # 把 src/*.js 复制到 lib/*.js
  test/                 # 验证脚本 / 诊断产物
```

## Host ↔ Client 契约（HTTP，同源，仅 loopback）

### GET `/api/dsh-thinking-zh/state`
```json
{ "enabled": true, "targetLanguage": "zh-Hans", "provider": "bing", "rev": 1730000000000 }
```

### POST `/api/dsh-thinking-zh/translate`
请求：
```json
{ "segments": [{ "id": "s1", "text": "I will inspect the plugin API first." }] }
```
响应：
```json
{ "results": [{ "id": "s1", "text": "我会先检查插件 API。", "cached": false }] }
```
- 单次最多 8 段、每段最多 4000 字符；超限返回 400。
- 单个片段翻译失败**不要**让整个请求失败：该段返回 `{"id":..., "text": null, "error": "..."}`。
- 服务端必须去重 + 缓存（内存 LRU + 磁盘 `$DSH_HOME/dsh-thinking-zh/cache.json`）。

### POST `/api/dsh-thinking-zh/set`
`{ "enabled"?: boolean, "targetLanguage"?: string }` → 返回同 GET `/state`。

### POST `/api/dsh-thinking-zh/diag`
`{ "name": "preview-dom", "payload": { ...任意 JSON... } }` →
把 `payload` 写到 `$DSH_HOME/dsh-thinking-zh/diag/<name>.json`，返回 `{ "ok": true, "path": "..." }`。
用于在没有 DevTools 的情况下把真实 DOM 结构回传给开发侧。**必须保留在最终版本里。**

### 安全
所有路由必须：仅 loopback（`127.0.0.1` / `::1`，含 `::ffff:` 前缀）+ Host 为 localhost/127.x + `Origin`（若有）同源。
参考实现：`$DSH_HOME\plugins\dsh-background\src\index.js` 里的 `isAllowed()` / `guard()` / `readBody()`。

## 翻译后端
- 默认 `bing`（免费、实测可用）：
  `POST https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false`
  body: `["第一段","第二段"]`，header `content-type: application/json`
  响应：`[{"translations":[{"text":"...","to":"zh-Hans"}]}, ...]`
- `google` 提供保留但不默认（本机被 429 反爬拦截）。
- 超时 10s；不自动切换 provider。

## Client 行为
1. 以 `window.__ModuleLoader__.load({ id: 'dsh-thinking-zh', factory })` 形式发布，`exports.apply(ctx)` / `exports.inject`。
2. 用 `MutationObserver` 监听 transcript；找到**折叠的思考预览文本节点**，防抖 400ms 后批量调用 `translate`，
   把该文本替换为中文（保留原英文到 `title` 属性与 `data-dsh-thinking-zh-original`）。
3. 流式期间预览会不断更新：只在文本"稳定"后翻译；已翻译的节点打标记，未变化不重复请求。
4. 跳过：代码块、工具输出、已经含大量中文字符的文本、纯数字/符号、< 6 字符。
5. 设置项从 `GET /state` 读取；`enabled=false` 时立即停止并恢复原文。
6. 任何异常都不得影响页面，不得抛出未捕获错误。

## 禁止
- 不得修改 React 管理的 DOM **结构**（不插入/删除元素、不改 innerHTML）；只允许改**文本节点内容**与属性。
- 不得改动 DSH 安装目录（`$DSH_INSTALL\...`）里的任何文件。
- 不得写入 `$DSH_HOME\profiles\desktop\`（安装步骤由 Lead 执行）。
