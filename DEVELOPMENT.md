# 开发文档 / Development Guide

<a id="chinese"></a>
**[English ↓](#english)** · [README](README.md)

本文面向维护者，记录实现细节、设计取舍与本项目的开发流程；面向用户的安装与使用说明见 [README](README.md)。源码注释为中英双语。

---

## 1. 项目定位

一个 **Manifest V3** 的 Neat Download Manager 浏览器扩展，从零重写。目标是把「用户真正想要的下载」交给本机 NDM，同时尽量不打扰浏览。

### 设计原则

| 原则 | 含义 | 代码体现 |
| --- | --- | --- |
| 宁可漏拦，不可误下 | 拿不准就不接管 | `decideCapture()` 的保守分支、兜底路径二次复核 |
| 媒体只进面板 | 页面播放的媒体不自动下载 | `kind: media/hls` 只发面板，不自动发送 |
| 数据不出本机 | 只与 `127.0.0.1` 通信 | `NDM_PROTOCOL.host = '127.0.0.1'` |
| 不延迟、不猜测 | 不做人为等待或文件名猜测 | 响应头到达即判定；不做 P2 式观察窗 |
| 无构建、无依赖 | 直接加载文件夹即可运行 | 纯 ES module，无打包器、无 npm 运行时依赖 |

### 非目标

- 不合并 DASH 音视频轨，不转码，不绕过 DRM。
- 不代理请求，不修改响应体。
- 不做云端同步、统计或账号体系。

---

## 2. 目录结构

```
manifest.json                 扩展清单（MV3，最小 Chrome 116）
src/
  background.js               Service Worker：捕获、NDM 客户端、状态、菜单、消息路由
  content/catcher.js          内容脚本：Ctrl 绕过、媒体扫描、Shadow DOM 媒体面板
  lib/
    constants.js              扩展名/MIME 集合、默认设置、协议参数、消息名、缓存上限
    rules.js                  decideCapture()：唯一的捕获判定入口
    ndm.js                    buildNdmMessage() 与 NdmClient（WebSocket）
    settings.js               chrome.storage 读写与归一化
    blocklist.js              屏蔽站点匹配（host + 子域）
    utils.js                  URL/文件名/头处理工具
  popup/                      工具栏弹窗（开关、最近捕获、媒体面板开关）
  options/                    设置页（端口、捕获选项、屏蔽列表）
  ui/base.css                 共享的 Chrome 原生风格变量
_locales/en, _locales/zh_CN   界面文案
tests/                        Node 单元/集成测试（无浏览器）
scripts/
  validate.mjs                清单、资源、i18n、版本一致性校验
  package.mjs                 生成发布 zip（可复现）
  web-test.mjs                真浏览器 + 假 NDM 的网页冒烟测试
  make_icons.py               生成图标
docs/                         隐私政策、商店权限说明、发布说明
img/                          图标
dist/                         打包输出（不入库）
```

---

## 3. 运行时架构

三个执行上下文：

| 上下文 | 生命周期 | 职责 |
| --- | --- | --- |
| Service Worker（`src/background.js`） | 事件唤醒，可随时休眠 | 捕获判定、NDM 连接、存储、徽标、右键菜单、消息路由 |
| 内容脚本（`src/content/catcher.js`） | 每个 http(s) 帧，`document_start` | Ctrl 绕过、媒体扫描、媒体面板 |
| UI 页面（popup / options） | 打开时 | 读取 `GET_STATE`、写入设置、控制面板 |

通信：`chrome.runtime.sendMessage`（页面 ↔ worker）与 `chrome.tabs.sendMessage`（worker → 内容脚本）。消息名集中在 `MSG`（`constants.js`）。

```
webRequest.onHeadersReceived ─► decideCapture ─► createPayload ─► NdmClient.send ─► ws://127.0.0.1:<port>/download
downloads.onCreated ──────────► 规则复核 ──────► 同上，并取消浏览器副本
content script ── MEDIA_FOUND ─► mediaByTab ──► 面板渲染（点击后 DOWNLOAD_URL，绕过规则）
```

---

## 4. 捕获路径

### 4.1 网络路径（webRequest）

| 事件 | 用途 |
| --- | --- |
| `onBeforeRequest` | 记录方法、POST 请求体（`requestBody`）、页面地址到 `requestContexts`；不做判定 |
| `onBeforeSendHeaders` | 记录 `Referer`、`Origin`、`X-*`、`Authorization` 等请求头 |
| `onHeadersReceived` | 唯一判定点：`seenHeaderUrls` 打标 → `isObviousBrowserAsset()` 快速排除 → `processHeaders()` |
| `onBeforeRedirect` / `onCompleted` / `onErrorOccurred` | 清理 `requestContexts` |

`processHeaders()` 依次做：

1. `decideCapture({ url, method, type, statusCode, contentType, contentDisposition, contentLength, contentRange, captureEnabled, captureMedia, ndmConnected, blocked, bypass, tabId })`。
2. 拒绝时：若原因是 `rfc2047-filename`，把 URL 记入 `browserOnlyUrls`（15 s），避免兜底路径再转发；其余直接返回。
3. 接受且为 `media`/`hls` 且 `showMediaPanel`：写入 `mediaByTab` 并推送给内容脚本（**不自动发送**）。
4. 非 `main_frame` 的媒体判定也直接返回（面板只服务当前页）。
5. 其余：取 Cookie → `createPayload()` → 注册 `inflightCaptures` → `sendToNdm({ expectBrowserDownload: true })`。

`sendToNdm()` 成功后写入 `recentSent`（12 s 去重）与 `pendingCancel`（15 s，供兜底路径取消浏览器副本），并广播 `STATE_CHANGED`。

### 4.2 浏览器下载兜底（`downloads.onCreated`）

按顺序检查，任一命中即返回：

1. `byExtensionId === chrome.runtime.id`（自己发起）。
2. 非 `http(s)`。
3. **`tabId < 0` 或非整数**：浏览器启动时恢复/续传的旧任务，不接管。
4. URL 或 `finalUrl` 是 DASH 分片（`M4S/CMFV/CMFA/CMFT`）。
5. `browserOnlyUrls` 命中（RFC 2047 文件名）。
6. Ctrl 绕过窗口内。
7. 站点被屏蔽。
8. `pendingCancel` / `inflightCaptures` / `recentSent` 命中：已在网络路径处理，直接取消浏览器副本。
9. `seenHeaderUrls` 命中：等最多 600 ms 让网络路径完成；若期间 `pendingCancel` 出现则取消并返回。
10. 用 `decideCapture({ type: 'main_frame', ... })` **复核**；不通过则放弃。
11. `targetUrl = item.finalUrl || item.url` → 发送 → 取消浏览器下载并 `chrome.downloads.erase()`。

> 第 10 步是关键：浏览器下载事件本身不是「用户意图」的证据，必须再走一遍规则。

### 4.3 手动路径

右键菜单 **使用 NDM 下载**（`MSG.DOWNLOAD_URL`）绕过 `decideCapture`，但仍有：站点屏蔽、Ctrl 绕过、NDM 未连接、端口校验。用于页面已消失或规则未识别的链接。

---

## 5. `decideCapture()` 规则

输入（`src/lib/rules.js`）：

| 字段 | 说明 |
| --- | --- |
| `url` | 必须是 http/https |
| `method` | 只接受 GET/POST |
| `statusCode` | 200 / 203 / 206（206 仅明确附件） |
| `type` | `main_frame`、`sub_frame`、`object`、`media`、`xmlhttprequest`、`other` |
| `contentType` / `contentDisposition` | 归一化后的响应头 |
| `contentLength` / `contentRange` | 大小推断 |
| `captureEnabled` / `captureMedia` / `ndmConnected` / `blocked` / `bypass` | 外部状态 |

输出：`{ capture, kind, reason, ext, size, filename, contentType }`。

### 判定顺序与拒绝原因

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 上下文缺失/被禁用/未连接/屏蔽/绕过 | `invalid-context` `capture-disabled` `ndm-disconnected` `site-blocked` `user-bypass` |
| 2 | 非 http(s)、方法、状态码 | `not-http` `method` `status` |
| 3 | 206 且非附件 | `partial-response` |
| 4 | HTML 页面且非附件 | `html-page` |
| 5 | 播放器预览图（B 站 `videoshot`）且非附件 | `preview-asset` |
| 6 | HLS 清单 | 接受 `hls` |
| 7 | 非媒体且 CD 文件名为 RFC 2047 编码字 | `rfc2047-filename`（交给浏览器） |
| 8 | 附件：浏览器原生 MIME 非顶层导航 | `internal-api` |
| 9 | 附件：非媒体且 XHR | `js-blob-download` |
| 10 | 图片 MIME | `image-asset` |
| 11 | 浏览器原生 MIME（CSS/JS/JSON/XML/WASM…） | `browser-asset` |
| 12 | 仅显式扩展名（HTML/PNG/JSON/Z/UTF8…） | `explicit-only` |
| 13 | 分片扩展名（TS/M4S…）且非导航/非媒体 | `stream-segment` |
| 14 | 媒体：面板关闭 / 分片 / XHR 分片 URL / 206 / 小于 `mediaMinSize` | `media-disabled` `stream-segment` `segment-url` `partial-media` `media-too-small` |
| 15 | 非媒体 XHR | `xhr-fetch` |
| 16 | 非 `main_frame` | `not-navigation` |
| 17 | 空文件 | `empty-file` |
| 18 | 自动扩展名 / 强制下载 MIME / 无扩展名且非浏览器资源 | 接受 `normal` |
| 19 | 其余 | `not-download` |

扩展名解析优先级：`MIME`（若不在仅显式集合）→ `Content-Disposition` 文件名 → URL 路径 → MIME 兜底。

集合语义（`constants.js`）：`AUTO_CAPTURE_EXTENSIONS`（媒体+压缩+文档）、`EXPLICIT_ONLY_EXTENSIONS`（必须附件）、`STREAM_SEGMENT_EXTENSIONS`（永不接管）、`NON_DOWNLOAD_MIMES`、`FORCED_DOWNLOAD_MIMES`。

---

## 6. NDM 协议

- 端点：`ws://127.0.0.1:<port>/download`，子协议 `neatextension.v1`，默认端口 `10007`。
- 消息为 CRLF 分隔的纯文本，字段编号与 NDM 官方扩展一致：

| 字段 | 含义 |
| --- | --- |
| `1:` | 方法（GET/POST） |
| `2:` | 下载 URL |
| `4:` | 页面标题 |
| `5:` | 页面 URL |
| `6:` | 任务类型 `normal` / `media` / `hls` |
| `7:` | 文件大小（字节，可省略） |
| `8:` | 响应 Content-Type（可省略） |
| `9:` | 面板显示标签 |
| `Origin:` / `Referer:` / `Cookie:` | 请求头 |
| `Content-Type:` | POST 请求体类型 |
| `__0NeatPostData9__:` | POST 请求体 |
| `X-*:` / `Authorization:` | 透传请求头 |

示例：

```
1:GET
2:https://example.com/file.zip
6:normal
4:下载页标题
Origin: https://example.com
Referer: https://example.com/page
5:https://example.com/page
Cookie: a=b
7:10485760
8:application/zip
```

注意事项：

- **不要发送响应 `Content-Disposition`**：NDM 会把它当作请求头回传给服务器（曾导致 416 / 命名错误）。
- 消息上限 `118784` 字节；超限先丢 `Cookie`，再丢 `X-*`/`Authorization`，仍超限则放弃。
- 收到 `Version=...` 记录 NDM 版本；`ShowPanelChrome=0/1` 同步 NDM 的面板偏好；`waiting` 触发一次 HEAD 补齐大小/类型（`handleNdmWaiting`）。
- 断线重连：`2 s` 起，按 `1.7` 倍退避，上限 `30 s`；Service Worker 用 `chrome.alarms` 保活。

---

## 7. 状态与存储

### chrome.storage

| 键 | 区域 | 内容 |
| --- | --- | --- |
| `settings` | local | `captureEnabled` `captureMedia` `showMediaPanel` `autoCancelBrowserDownload` `ndmPort` `mediaMinSize` |
| `blockedSites` | local | 主机名数组（去重、小写） |
| `sessionState` | session | `recentCaptures`、`bypassUntil` 等会话级状态 |

`normalizeSettings()` 会对端口（1–65535）与 `mediaMinSize`（0–512 MB）做钳制。

### 内存结构（worker 内）

| 名称 | 上限 | 用途 |
| --- | --- | --- |
| `requestContexts` | 3000 | 按 `requestId` 暂存 POST 体与请求头 |
| `recentSent` | 500 | 12 s 内的去重 |
| `pendingCancel` | 100 | 等待浏览器下载事件以取消副本 |
| `inflightCaptures` | — | 网络路径正在发送的任务 |
| `seenHeaderUrls` | — | 12 s 内已见过响应头的 URL |
| `browserOnlyUrls` | — | RFC 2047 下载，只允许浏览器完成 |
| `mediaByTab` | 30/标签 | 媒体面板条目 |
| `tabInfo` | — | 标签页 URL/标题缓存 |
| `panelOpenTabs` | — | 面板展开的标签页 |

所有过期表通过 `pruneExpiring(map, limit)` 清理，避免长时间运行后膨胀。

---

## 8. 媒体面板

- 数据来源：DOM（`video`、`audio`、`source`、`embed`、`object`）、网络媒体（`kind: media/hls` 且 `showMediaPanel`）、B 站 `__playinfo__` 的 `dash.video/audio`。
- 面板由内容脚本创建：`panelHost`（Shadow DOM）+ `launcher`（最小化胶囊）。默认 `collapsed = true`。
- 展开/收起通过 `PANEL_STATE { open }` 与 worker 的 `panelOpenTabs` 同步；`GET_STATE` 返回当前标签的 `panelOpen`，popup 开关与之双向联动。
- 导航（`webNavigation.onCommitted`）重置该标签的展开状态；设置项关闭时移除面板。
- 不可下载的源（DRM、`blob:`、`data:`、MSE-only）不列出。
- 点击条目发送 `DOWNLOAD_URL`（手动路径）。

---

## 9. Ctrl 绕过

- 内容脚本在 `keydown` 捕获阶段记录 Ctrl/⌘（macOS），点击链接时若仍按住则 `BYPASS { ttl: 4000 }`。
- 聚焦链接上按 Enter 同样生效。
- worker 维护 `bypassUntil`，`isBypassed()` 在有效期内让所有捕获路径直接放弃，并写入 `sessionState` 以便 worker 重启后仍有效。
- 页面显示一次 toast：`bypassToast`。

---

## 10. 权限

| 权限 | 用途 |
| --- | --- |
| `webRequest` | 读取响应头，判定下载（不修改请求） |
| `downloads` | 读取浏览器下载事件、取消并清理重复副本 |
| `cookies` | 为 NDM 附上目标站点的 Cookie（含分区 Cookie） |
| `storage` | 设置、屏蔽列表、会话状态 |
| `tabs` | 当前标签页地址/标题、徽标、消息路由 |
| `webNavigation` | 导航时重置面板状态与缓存 |
| `contextMenus` | 右键「使用 NDM 下载」「屏蔽此站点的下载」 |
| `alarms` | Service Worker 保活与重连 |
| `host_permissions: <all_urls>` | 下载可能来自任意站点 |

商店文案与隐私政策见 [`docs/permission-justifications.md`](docs/permission-justifications.md)、[`docs/privacy-policy.md`](docs/privacy-policy.md)。

---

## 11. 构建与打包

无需构建：仓库根目录本身就是可加载的扩展。发布包由 `scripts/package.mjs` 生成：

1. `collectFiles(manifest)`：从 `manifest.json` 出发，解析 HTML 的 `<link>`/`<script>`/`<img>`、CSS 的 `url()`、ES module 的 `import`，递归收集运行时文件；再补 `_locales/**`、`LICENSE`。
2. 用 `node:zlib deflateRawSync` 手写 ZIP（固定时间戳、CRC32），保证同一份源码产物一致。
3. 输出 `dist/openndm-extension-v<version>.zip`。

```bash
npm run package                 # validate + 打包
node scripts/package.mjs --dry-run   # 只看文件清单
node scripts/package.mjs --out custom.zip
```

打包**不在每次修改时执行**：只有明确要求发布时才运行。

---

## 12. 测试

### 单元/集成测试（`npm test`，无浏览器）

| 文件 | 覆盖 |
| --- | --- |
| `tests/background.test.mjs` | 消息路由、状态、设置归一化 |
| `tests/rules.test.mjs` | `decideCapture()` 的正反例（约 30 条） |
| `tests/capture.test.mjs` | 用假的 `chrome.*` 驱动完整捕获链（网络路径、兜底、取消、面板、绕过） |
| `tests/package.test.mjs` | 打包文件清单与可复现性 |

`capture.test.mjs` 通过 `globalThis.chrome = {...}` 模拟 API，用 `FakeWebSocket` 记录发往 NDM 的消息，并用 `events.*` 手动触发监听器。

### 网页冒烟测试（`npm run test:web`，需要浏览器与网络）

- 用临时 profile 启动 Chrome/Edge，通过 CDP `Extensions.loadUnpacked` 加载扩展（Chrome 137+ 品牌版已忽略 `--load-extension`）。
- 把扩展复制到临时目录，并把 `DEFAULT_SETTINGS.ndmPort` 改写为假 NDM 的端口，避免碰本机 NDM。
- 假 NDM 是一个最小 WebSocket 服务，只记录消息、不应答下载。
- 逐个打开免登录站点（百度、新浪、网易、腾讯网、知乎、豆瓣、36氪、CSDN、博客园、B 站、爱奇艺、京东），停留 N 秒，读取资源数与标题确认页面确实加载，再关闭。
- 有捕获即失败（打印 URL 与类型）；页面未加载标为「跳过」且不计入结论。

```bash
npm run test:web -- --seconds 7 --browser edge --headed --filter 知乎
```

---

## 13. 版本号

- 写在 `manifest.json` 的 `version`，并同步到 `package.json`；`npm run check` 校验一致。
- 每次修改递增第三位；第三位满 10 进一到第二位：`0.2.1` → `0.2.2` … `0.2.9` → `0.3.0`。
- Chrome 的版本比较按分段数值，进位规则由本项目自定，避免出现 `0.1.11` 这类第三位。

---

## 14. 本地化

- 文案位于 `_locales/en/messages.json` 与 `_locales/zh_CN/messages.json`，键名一致。
- `default_locale: "en"`，不支持的语言回退英文。
- `scripts/validate.mjs` 校验：`t('key')` 在代码中出现的键必须存在于两个语言包；两包键集合一致。

---

## 15. 调试

- Service Worker 日志：`chrome://extensions` → 本扩展 → **Service Worker**。
- 内容脚本日志：页面 DevTools Console（面板相关）。
- NDM 侧日志：`%APPDATA%\NeatDM\<id>\LogFile.txt`；数据库 `%APPDATA%\NeatDM\NeatDB.db`（只读排查用）。
- 常见拒绝原因与含义见第 5 节表格；`not-download` 通常表示规则未识别，可用右键 **使用 NDM 下载** 验证是否为真实文件。

---

## 16. 已知取舍

- NDM 协议没有文件名字段，命名由服务器 `Content-Disposition` 或 URL 决定；扩展不会、也无法强制改名。
- `blob:` 下载只能在浏览器完成；若页面用 `fetch` 取回再转 blob，NDM 无法获得真实文件名，这类下载留给浏览器。
- RFC 2047 编码文件名交给浏览器，代价是这类下载不进 NDM。
- 浏览器启动时恢复的旧下载没有来源标签页，一律不接管。
- 媒体一律只进面板，避免广告/弹幕/分片轰炸。

---

<a id="english"></a>
# Development Guide

**[中文 ↑](#chinese)** · [README](README.md)

This document is for maintainers: implementation details, design trade-offs, and the development workflow. User-facing installation and usage notes live in [README](README.md). Source comments are bilingual.

## 1. Project scope

A clean **Manifest V3** rewrite of the Neat Download Manager browser extension. The aim is to hand the downloads users actually want to the local NDM app while staying out of normal browsing.

### Design principles

| Principle | Meaning | Where it shows up |
| --- | --- | --- |
| Better to miss than to over-capture | Anything uncertain is not taken over | conservative branches in `decideCapture()`, re-check in the browser-download fallback |
| Media only in the panel | Media played by a page is never downloaded automatically | `kind: media/hls` feed the panel only |
| Data never leaves the machine | Only talks to `127.0.0.1` | `NDM_PROTOCOL.host = '127.0.0.1'` |
| No delay, no guessing | No artificial waits, no filename guessing | decide on response headers; no grace window |
| No build, no dependencies | The folder runs as-is | plain ES modules, no bundler, no runtime npm dependencies |

### Non-goals

- No DASH track merging, no transcoding, no DRM bypass.
- No request proxying, no response rewriting.
- No cloud sync, analytics, or accounts.

## 2. Project layout

```
manifest.json                 extension manifest (MV3, minimum Chrome 116)
src/
  background.js               Service Worker: capture, NDM client, state, menus, message routing
  content/catcher.js          content script: Ctrl bypass, media scan, Shadow DOM media panel
  lib/
    constants.js              extension/MIME sets, defaults, protocol constants, message names, cache limits
    rules.js                  decideCapture(): the only capture decision entry point
    ndm.js                    buildNdmMessage() and NdmClient (WebSocket)
    settings.js               chrome.storage read/write and normalisation
    blocklist.js              blocked-site matching (host and subdomains)
    utils.js                  URL/filename/header helpers
  popup/                      toolbar popup (switches, recent captures, media panel switch)
  options/                    options page (port, capture options, blocklist)
  ui/base.css                 shared Chrome-native style variables
_locales/en, _locales/zh_CN   UI strings
tests/                        Node unit/integration tests (no browser)
scripts/
  validate.mjs                manifest, resource, i18n, and version validation
  package.mjs                 reproducible release zip
  web-test.mjs                real-browser smoke test with a fake NDM
  make_icons.py               icon generator
docs/                         privacy policy, store permission justifications, build notes
img/                          icons
dist/                         build output (not committed)
```

## 3. Runtime architecture

Three execution contexts:

| Context | Lifetime | Responsibility |
| --- | --- | --- |
| Service Worker (`src/background.js`) | event-driven, may sleep | capture decisions, NDM connection, storage, badge, context menus, message routing |
| Content script (`src/content/catcher.js`) | every http(s) frame at `document_start` | Ctrl bypass, media scan, media panel |
| UI pages (popup / options) | while open | read `GET_STATE`, write settings, control the panel |

Communication: `chrome.runtime.sendMessage` (pages ↔ worker) and `chrome.tabs.sendMessage` (worker → content script). Message names live in `MSG` (`constants.js`).

```
webRequest.onHeadersReceived ─► decideCapture ─► createPayload ─► NdmClient.send ─► ws://127.0.0.1:<port>/download
downloads.onCreated ──────────► rule re-check ─► same as above, then cancel the browser copy
content script ── MEDIA_FOUND ─► mediaByTab ──► panel rendering (clicks send DOWNLOAD_URL, bypassing rules)
```

## 4. Capture paths

### 4.1 Network path (webRequest)

| Event | Purpose |
| --- | --- |
| `onBeforeRequest` | record method, POST body (`requestBody`), and page URL in `requestContexts`; no decision |
| `onBeforeSendHeaders` | record `Referer`, `Origin`, `X-*`, `Authorization`, and other request headers |
| `onHeadersReceived` | the only decision point: mark `seenHeaderUrls` → `isObviousBrowserAsset()` fast skip → `processHeaders()` |
| `onBeforeRedirect` / `onCompleted` / `onErrorOccurred` | drop `requestContexts` entries |

`processHeaders()` runs, in order:

1. `decideCapture({ url, method, type, statusCode, contentType, contentDisposition, contentLength, contentRange, captureEnabled, captureMedia, ndmConnected, blocked, bypass, tabId })`.
2. On rejection: if the reason is `rfc2047-filename`, record the URL in `browserOnlyUrls` (15 s) so the fallback does not forward it; otherwise return.
3. On acceptance with `media`/`hls` and `showMediaPanel`: push to `mediaByTab` and the content script (**no automatic send**).
4. Media decided for a non-`main_frame` request also returns early (the panel only serves the current page).
5. Everything else: fetch cookies → `createPayload()` → register `inflightCaptures` → `sendToNdm({ expectBrowserDownload: true })`.

After a successful `sendToNdm()`, the URL is recorded in `recentSent` (12 s dedupe) and `pendingCancel` (15 s, used by the fallback to cancel the browser copy), and `STATE_CHANGED` is broadcast.

### 4.2 Browser download fallback (`downloads.onCreated`)

Checked in order; the first hit returns:

1. `byExtensionId === chrome.runtime.id` (started by us).
2. Not `http(s)`.
3. **`tabId < 0` or not an integer**: downloads the browser restored or resumed at startup; never taken over.
4. URL or `finalUrl` is a DASH fragment (`M4S/CMFV/CMFA/CMFT`).
5. `browserOnlyUrls` hit (RFC 2047 filename).
6. Inside the Ctrl bypass window.
7. Site blocked.
8. `pendingCancel` / `inflightCaptures` / `recentSent` hit: already handled by the network path, so cancel the browser copy.
9. `seenHeaderUrls` hit: wait up to 600 ms for the network path; if `pendingCancel` appears meanwhile, cancel and return.
10. Re-check with `decideCapture({ type: 'main_frame', ... })`; if it does not pass, give up.
11. `targetUrl = item.finalUrl || item.url` → send → cancel the browser download and `chrome.downloads.erase()` it.

> Step 10 matters: a browser download event is not proof of user intent and must pass the same rules.

### 4.3 Manual path

The **Download with NDM** context menu item (`MSG.DOWNLOAD_URL`) bypasses `decideCapture`, but still honours the site blocklist, Ctrl bypass, "NDM not connected", and port validation. It exists for links whose page is gone or that the rules cannot recognise.

## 5. `decideCapture()` rules

Input (`src/lib/rules.js`):

| Field | Meaning |
| --- | --- |
| `url` | must be http/https |
| `method` | GET/POST only |
| `statusCode` | 200 / 203 / 206 (206 only for explicit attachments) |
| `type` | `main_frame`, `sub_frame`, `object`, `media`, `xmlhttprequest`, `other` |
| `contentType` / `contentDisposition` | normalised response headers |
| `contentLength` / `contentRange` | size inference |
| `captureEnabled` / `captureMedia` / `ndmConnected` / `blocked` / `bypass` | external state |

Output: `{ capture, kind, reason, ext, size, filename, contentType }`.

### Order and rejection reasons

| Step | Condition | Result |
| --- | --- | --- |
| 1 | missing context / disabled / not connected / blocked / bypassed | `invalid-context` `capture-disabled` `ndm-disconnected` `site-blocked` `user-bypass` |
| 2 | not http(s), method, status | `not-http` `method` `status` |
| 3 | 206 without attachment | `partial-response` |
| 4 | HTML page without attachment | `html-page` |
| 5 | player preview sprite (Bilibili `videoshot`) without attachment | `preview-asset` |
| 6 | HLS playlist | accept as `hls` |
| 7 | non-media and the CD filename is an RFC 2047 word | `rfc2047-filename` (browser handles it) |
| 8 | attachment with a browser-native MIME outside a top-level navigation | `internal-api` |
| 9 | attachment, non-media, XHR | `js-blob-download` |
| 10 | image MIME | `image-asset` |
| 11 | browser-native MIME (CSS/JS/JSON/XML/WASM…) | `browser-asset` |
| 12 | explicit-only extension (HTML/PNG/JSON/Z/UTF8…) | `explicit-only` |
| 13 | segment extension (TS/M4S…), non-navigation and non-media | `stream-segment` |
| 14 | media: panel off / segment / segment URL on XHR / 206 / below `mediaMinSize` | `media-disabled` `stream-segment` `segment-url` `partial-media` `media-too-small` |
| 15 | non-media XHR | `xhr-fetch` |
| 16 | not `main_frame` | `not-navigation` |
| 17 | empty file | `empty-file` |
| 18 | auto-capture extension / forced-download MIME / extensionless non-browser asset | accept as `normal` |
| 19 | anything else | `not-download` |

Extension resolution: `MIME` (unless explicit-only) → `Content-Disposition` filename → URL path → MIME fallback.

Set semantics (`constants.js`): `AUTO_CAPTURE_EXTENSIONS` (media + archives + documents), `EXPLICIT_ONLY_EXTENSIONS` (require an attachment), `STREAM_SEGMENT_EXTENSIONS` (never captured), `NON_DOWNLOAD_MIMES`, `FORCED_DOWNLOAD_MIMES`.

## 6. NDM protocol

- Endpoint: `ws://127.0.0.1:<port>/download`, subprotocol `neatextension.v1`, default port `10007`.
- Messages are CRLF-separated plain text; field numbers match the official NDM extension:

| Field | Meaning |
| --- | --- |
| `1:` | method (GET/POST) |
| `2:` | download URL |
| `4:` | page title |
| `5:` | page URL |
| `6:` | task kind `normal` / `media` / `hls` |
| `7:` | file size in bytes (optional) |
| `8:` | response Content-Type (optional) |
| `9:` | panel label |
| `Origin:` / `Referer:` / `Cookie:` | request headers |
| `Content-Type:` | POST body type |
| `__0NeatPostData9__:` | POST body |
| `X-*:` / `Authorization:` | forwarded request headers |

Example:

```
1:GET
2:https://example.com/file.zip
6:normal
4:Page title
Origin: https://example.com
Referer: https://example.com/page
5:https://example.com/page
Cookie: a=b
7:10485760
8:application/zip
```

Notes:

- **Never send the response `Content-Disposition`**: NDM forwards it to the server as a request header (this used to cause 416s and wrong names).
- Message limit `118784` bytes; drop `Cookie` first, then `X-*`/`Authorization`, then give up.
- `Version=...` records the NDM version; `ShowPanelChrome=0/1` mirrors NDM's panel preference; `waiting` triggers a one-off HEAD request to fill size/type (`handleNdmWaiting`).
- Reconnect: starts at `2 s`, backs off by `1.7×`, caps at `30 s`; the worker stays alive with `chrome.alarms`.

## 7. State and storage

### chrome.storage

| Key | Area | Content |
| --- | --- | --- |
| `settings` | local | `captureEnabled` `captureMedia` `showMediaPanel` `autoCancelBrowserDownload` `ndmPort` `mediaMinSize` |
| `blockedSites` | local | hostname list (deduped, lowercase) |
| `sessionState` | session | `recentCaptures`, `bypassUntil`, and other session state |

`normalizeSettings()` clamps the port (1–65535) and `mediaMinSize` (0–512 MB).

### In-memory structures (worker)

| Name | Limit | Purpose |
| --- | --- | --- |
| `requestContexts` | 3000 | POST body and headers per `requestId` |
| `recentSent` | 500 | 12 s dedupe |
| `pendingCancel` | 100 | waiting for the browser download to cancel |
| `inflightCaptures` | — | network captures currently sending |
| `seenHeaderUrls` | — | URLs whose headers were seen in the last 12 s |
| `browserOnlyUrls` | — | RFC 2047 downloads that must stay in the browser |
| `mediaByTab` | 30/tab | media panel entries |
| `tabInfo` | — | tab URL/title cache |
| `panelOpenTabs` | — | tabs with an expanded panel |

All expiring maps are pruned by `pruneExpiring(map, limit)` to keep long sessions bounded.

## 8. Media panel

- Sources: DOM (`video`, `audio`, `source`, `embed`, `object`), network media (`kind: media/hls` with `showMediaPanel`), and Bilibili `__playinfo__` `dash.video/audio`.
- The content script creates `panelHost` (Shadow DOM) plus `launcher` (minimised pill). Default is `collapsed = true`.
- Expanding/collapsing syncs `PANEL_STATE { open }` with the worker's `panelOpenTabs`; `GET_STATE` returns the current tab's `panelOpen`, and the popup switch is two-way bound.
- Navigation (`webNavigation.onCommitted`) resets the expanded state for that tab; disabling the setting removes the panel.
- Undownloadable sources (DRM, `blob:`, `data:`, MSE-only) are not listed.
- Clicking an entry sends `DOWNLOAD_URL` (manual path).

## 9. Ctrl bypass

- The content script tracks Ctrl/⌘ (macOS) during the capture-phase `keydown`; if it is still held on click, it sends `BYPASS { ttl: 4000 }`.
- Enter on a focused link works the same way.
- The worker keeps `bypassUntil`; `isBypassed()` makes every capture path give up while active and persists the window in `sessionState` so a worker restart keeps it.
- The page shows a one-off `bypassToast`.

## 10. Permissions

| Permission | Purpose |
| --- | --- |
| `webRequest` | read response headers to decide captures (requests are never modified) |
| `downloads` | read browser download events, cancel and erase duplicate copies |
| `cookies` | attach the target site's cookies (including partitioned ones) for NDM |
| `storage` | settings, blocklist, session state |
| `tabs` | current tab URL/title, badge, message routing |
| `webNavigation` | reset panel state and caches on navigation |
| `contextMenus` | **Download with NDM** and **Block downloads on this site** |
| `alarms` | keep the Service Worker alive and retry connections |
| `host_permissions: <all_urls>` | downloads can come from any site |

Store copy and privacy policy: [`docs/permission-justifications.md`](docs/permission-justifications.md), [`docs/privacy-policy.md`](docs/privacy-policy.md).

## 11. Build and packaging

No build step: the repository root is the loadable extension. The release archive is produced by `scripts/package.mjs`:

1. `collectFiles(manifest)`: start at `manifest.json`, resolve HTML `<link>`/`<script>`/`<img>`, CSS `url()`, and ES module `import` references recursively; then add `_locales/**` and `LICENSE`.
2. Write the ZIP by hand with `node:zlib deflateRawSync` (fixed timestamps, CRC32) so identical sources produce an identical archive.
3. Emit `dist/openndm-extension-v<version>.zip`.

```bash
npm run package                 # validate + package
node scripts/package.mjs --dry-run   # preview the file list
node scripts/package.mjs --out custom.zip
```

Packaging is **not** part of every change: run it only when a release build is requested.

## 12. Tests

### Unit/integration tests (`npm test`, no browser)

| File | Coverage |
| --- | --- |
| `tests/background.test.mjs` | message routing, state, settings normalisation |
| `tests/rules.test.mjs` | positive and negative `decideCapture()` cases (about 30) |
| `tests/capture.test.mjs` | full capture chain driven by fake `chrome.*` APIs (network path, fallback, cancel, panel, bypass) |
| `tests/package.test.mjs` | archive file list and reproducibility |

`capture.test.mjs` installs `globalThis.chrome = {...}` to mock the APIs, records messages sent to NDM with a `FakeWebSocket`, and fires listeners through `events.*`.

### Web smoke test (`npm run test:web`, needs a browser and network)

- Starts Chrome/Edge with a throwaway profile and loads the extension through the CDP `Extensions.loadUnpacked` command (branded Chrome 137+ ignores `--load-extension`).
- Copies the extension to a temp directory and rewrites `DEFAULT_SETTINGS.ndmPort` to the fake NDM's port, so the real NDM is never touched.
- The fake NDM is a minimal WebSocket server that records messages and never downloads anything.
- Opens login-free sites one by one (Baidu, Sina, NetEase, QQ, Zhihu, Douban, 36Kr, CSDN, cnblogs, Bilibili, iQiyi, JD), waits N seconds, reads the resource count and title to confirm the page loaded, then closes it.
- Any capture fails the run (URL and kind are printed); pages that did not load are marked as skipped and excluded from the verdict.

```bash
npm run test:web -- --seconds 7 --browser edge --headed --filter 知乎
```

## 13. Versioning

- Stored in `manifest.json` (`version`) and mirrored in `package.json`; `npm run check` verifies they match.
- Raise the third component on every change; when it reaches 10 it carries into the second: `0.2.1` → `0.2.2` … `0.2.9` → `0.3.0`.
- Chrome compares versions numerically per component; the carry rule is this project's own choice, adopted so a third component like `0.1.11` never appears.

## 14. Localization

- Strings live in `_locales/en/messages.json` and `_locales/zh_CN/messages.json` with identical keys.
- `default_locale: "en"`; unsupported languages fall back to English.
- `scripts/validate.mjs` checks that every `t('key')` used in code exists in both locales and that the two key sets match.

## 15. Debugging

- Service worker logs: `chrome://extensions` → this extension → **Service Worker**.
- Content script logs: page DevTools console (panel-related).
- NDM side: `%APPDATA%\NeatDM\<id>\LogFile.txt`; database `%APPDATA%\NeatDM\NeatDB.db` (read-only diagnostics).
- Rejection reasons are listed in section 5; `not-download` usually means the rules did not recognise the file — use **Download with NDM** from the context menu to confirm it is a real file.

## 16. Trade-offs

- The NDM protocol has no filename field; names come from the server's `Content-Disposition` or the URL. The extension cannot force a different name.
- `blob:` downloads can only complete in the browser; when a page fetches a file and re-wraps it as a blob, NDM cannot learn the real filename, so those downloads stay in the browser.
- RFC 2047 encoded filenames are handed to the browser; the cost is that those downloads skip NDM.
- Old downloads the browser restores at startup have no originating tab and are never taken over.
- Media always goes to the panel only, which keeps ads, danmaku, and segments out of NDM.
