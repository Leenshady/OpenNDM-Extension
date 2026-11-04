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
  check.mjs                   推送门禁：validate + 四个单元测试 + 夹具全量（push 前必须全绿）
  package.mjs                 生成发布 zip（可复现）
  web-test.mjs                真浏览器 + 假 NDM 的网页冒烟测试
  fixtures.mjs                本地下载场景夹具服务与逐场景断言（供 web-test --fixtures 使用）
  make_icons.py               生成图标
.github/workflows/release.yml 手动触发的发布流水线（门禁 → zip → crx → Release）
.githooks/pre-push            本地 push 门禁，需 `git config core.hooksPath .githooks` 启用
docs/                         隐私政策、商店权限说明、发布说明
DOWNLOAD-STANDARDS.md         下载相关标准与真实实现（判定规则的依据手册）
ROADMAP.md                    开发计划、能力上限、永久不做清单
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

1. `decideCapture({ url, method, type, statusCode, contentType, contentDisposition, contentLength, contentRange, captureEnabled, captureMedia, ndmConnected, blocked, bypass })`。
2. 拒绝时：若原因属于 `BROWSER_ONLY_REASONS`（`rfc2047-filename`、`post-body-too-large`），把 URL 记入 `browserOnlyUrls`（`LIMITS.browserOnlyMs`，默认 15 s），避免兜底路径再转发；其余直接返回。
   这两个原因都意味着「只有浏览器能正确完成这次下载」：RFC 2047 文件名 NDM 解不了，超限 POST 体没有可重放的请求体，兜底路径只会按 GET 重取。
3. 接受且为 `media`/`hls` 且 `showMediaPanel`：写入 `mediaByTab` 并推送给内容脚本（**不自动发送**）。
4. 非 `main_frame` 的媒体判定也直接返回（面板只服务当前页）。
5. 其余：取 Cookie → `createPayload()` → 注册 `inflightCaptures` → `sendToNdm({ expectBrowserDownload: true })`。

`sendToNdm()` 成功后写入 `recentSent`（12 s 去重）与 `pendingCancel`（15 s，供兜底路径取消浏览器副本），并广播 `STATE_CHANGED`。

### 4.2 浏览器下载兜底（`downloads.onCreated`）

按顺序检查，任一命中即返回：

1. `byExtensionId === chrome.runtime.id`（自己发起）。
2. 非 `http(s)`。
3. URL 或 `finalUrl` 是 DASH 分片（`M4S/CMFV/CMFA/CMFT`）。
4. `browserOnlyUrls` 命中（RFC 2047 文件名）。
5. Ctrl 绕过窗口内。
6. `pendingCancel` / `inflightCaptures` / `recentSent` 命中：已在网络路径发送过，**无论有没有来源标签页**都取消浏览器副本并返回。
7. NDM 未连接 → 返回。
8. **`tabId < 0` 或非整数**：既没来源标签页、也没发送过，属于浏览器启动时恢复/续传的旧任务，不发送。
9. 站点被屏蔽。
10. `seenHeaderUrls` 命中：等最多 600 ms 让网络路径完成；若期间 `pendingCancel` 出现则取消并返回。
11. 用 `decideCapture({ type: 'main_frame', ... })` **复核**；不通过则放弃。
12. `targetUrl = item.finalUrl || item.url` → 发送 → 取消浏览器下载并 `chrome.downloads.erase()`。

> 第 11 步是关键：浏览器下载事件本身不是「用户意图」的证据，必须再走一遍规则。
> 第 6 步同样关键：取消动作只取决于「是否已交给 NDM」，与标签页无关；漏取消就会同时留下 NDM 与浏览器两份文件。

### 4.3 手动路径

右键菜单 **使用 NDM 下载**（`MSG.DOWNLOAD_URL`）绕过 `decideCapture`，但仍有：站点屏蔽、Ctrl 绕过、NDM 未连接、端口校验。用于页面已消失或规则未识别的链接。

---

## 5. `decideCapture()` 规则

规则背后的**行业标准与真实实现**（RFC 9110/6266/8187/2047、`<a download>` 边界、fetch+blob、Range/206、`Sec-Fetch-*`、MV3 能力、差距清单 G1–G12（含每条当前状态）见 [DOWNLOAD-STANDARDS.md](DOWNLOAD-STANDARDS.md)。改判定分支前先查那张表。

输入（`src/lib/rules.js`）：

| 字段 | 说明 |
| --- | --- |
| `url` | 必须是 http/https |
| `method` | 只接受 GET/POST |
| `statusCode` | 200 / 203 / 206（206 仅明确附件） |
| `type` | `main_frame`、`sub_frame`、`object`、`media`、`xmlhttprequest`、`other` |
| `contentType` / `contentDisposition` | 归一化后的响应头 |
| `contentLength` / `contentRange` | 大小推断 |
| `contentEncoding` | 压缩响应（gzip/br/deflate）时大小未知：`Content-Length` 描述的是编码后字节，`size` 归 0 |
| `postBodyTooLarge` | POST 体超过 96KB：不重放半截请求体 |
| `captureEnabled` / `captureMedia` / `ndmConnected` / `blocked` / `bypass` | 外部状态 |

输出：`{ capture, kind, reason, ext, size, filename, contentType }`。

### 判定顺序与拒绝原因

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 上下文缺失/被禁用/未连接/屏蔽/绕过 | `invalid-context` `capture-disabled` `ndm-disconnected` `site-blocked` `user-bypass` |
| 2 | 非 http(s)、方法、POST 体超 96KB、状态码 | `not-http` `method` `post-body-too-large` `status` |
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
| `7:` | 文件大小（字节，可省略）；响应带 `Content-Encoding`（非 `identity`）时**不写这一行**，因为 `Content-Length` 描述的是压缩后字节 |
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
| `panelPlace` | local | 胶囊原点与贴边方向 `{ left, top, dock }`（卡片是它的浮层，偏移现算，不单独存）；只是界面偏好，读写失败不影响捕获 |
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
- 面板由内容脚本创建：`panelHost`（Shadow DOM）+ 卡片 `.panel` + 胶囊 `.launcher`。默认 `collapsed = true`，三种状态互斥：折叠只有胶囊、展开只有卡片、贴边只有收成圆球的胶囊（复盘见 [docs/ui-review-panel.md](docs/ui-review-panel.md)）。
- 展开/收起通过 `PANEL_STATE { open }` 与 worker 的 `panelOpenTabs` 同步；`GET_STATE` 返回当前标签的 `panelOpen`，popup 开关与之双向联动。
- 导航（`webNavigation.onCommitted`）重置该标签的展开状态；设置项关闭时移除面板。
- 不可下载的源（DRM、`blob:`、`data:`、MSE-only）不列出。
- 点击条目发送 `DOWNLOAD_URL`（手动路径）。
- **自由拖动**：标题栏 `.head` 与胶囊都能拖动（pointer 事件），位置夹在可视区内；松手时若「卡片 ∪ 胶囊」的并集距某条边 ≤ `PLACE_SNAP`（24px）就吸附到该边——并集是必需的：卡片永远开在胶囊上方，只量胶囊的话上下左右四条边只有两条能被这个手势触发。
- **视口基准是不含滚动条的可视区**：横向用 `documentElement.clientWidth`（`viewportWidth()`），纵向用 `clientHeight`。`window.innerWidth` 把 classic 滚动条轨道算在内，Windows 默认的「预留位置的细滚动条」同样预留宽度（实测 15px），按它定位会让卡片或胶囊正好压在滚动条下面。展开高度上限为 `min(430px, 80vh)`：卡片比可视区还高时上下夹紧互相矛盾，图标与卡片都会掉出去点不到。
- **贴边隐藏（只有胶囊会贴边）**：`place = { left, top, dock }` 永远是**胶囊左上角**。`applyPlace()` 把停靠轴钉在可视区边上，再给胶囊加一个 `translate(calc(-100% + DOCK_PEEK))`（左/上）或 `translate(calc(100% - DOCK_PEEK))`（右/下）的沉入位移——注意方向：左贴边留在屏内的是元素**右侧**那 30px。所以 `DOCK_PEEK`（30）必须 ≥ 球心 20 + 图标半宽 8.5，图标才完整可见；胶囊同时收成 40px 正圆、徽标平滑退场。探出时夹紧宽度改用整颗胶囊的 `PILL_FLOAT_W`，否则探出的半截会挂出视口。点它先脱离贴边再展开，一开始拖动也自动脱离；从边上点开的面板再收起时吸回**同一条边**（`dockResume`，见下）。卡片从不参与沉入，屏上不存在「半截卡片」。
- **探出判定是两块静态矩形，不是元素自己的 hover**：`hoverRects()` 只由 `place`、贴边方向和可视区算出两块区域，window 的 passive `pointermove` 拿指针坐标对它求命中——`enter` 是**沉住时胶囊在屏内留下的那一条**（`DOCK_PEEK × DOCK_SIZE`，停靠轴钉在边上），`keep` 是**探出后整颗胶囊**（`PILL_FLOAT_W × 高`），两者外沿再各放宽 `HOVER_MARGIN`（8px）。不能用胶囊的 `pointerenter/pointerleave`：胶囊一动命中就重算，探出→离开→收回→再进入自激循环，指针停在边附近表现为无限弹出/收起。`enter` 只认露出的那一条是关键：旧判据按整颗胶囊算，离边还有几十像素球就弹了，用户看到的是「鼠标还没到贴边胶囊就弹出」。探出后要收回，指针必须彻底走出 `keep` 再放宽 8px，所以在球身上逛、原地 1px 抖动都不翻状态。刚吸附或刚收回边上时 `hoverArmed` 置假：指针就停在刚形成的那块区域里，不解除会立刻把球弹回屏内；指针完全走出该区域再回来时重新武装。
- **收起回到原来的边**：点贴边胶囊展开卡片时把 `place.dock` 记进 `dockResume`，`setPanelCollapsed(true)`（点 ⌄ 或点网页其他地方）发现 `dock` 已空而 `dockResume` 有值，就把停靠方向写回去、重贴边并落盘——否则胶囊会飘在刚脱离的位置上，看起来像「贴边被点开又贴不回去了」。真拖动会清空 `dockResume`：用户已经把它挪走，收起时不该再吸回老边缘。
- **点击网页其他地方自动收起**：`document` 捕获阶段的 `pointerdown`（页面的 `stopPropagation` 拦不住）在面板展开时把卡片折回胶囊；`event.composedPath()` 里有 `panelHost` 或 `toastHost` 才算「点在内部」——面板与提示各挂各的 shadow host，光比 `event.target` 认不出跨 shadow 的归属。拖动中（`dragSession`）与非左键不触发。
- **展开/收起不跳位**：卡片是胶囊的浮层，偏移由 `applyCardAnchor()` 现算（右对齐、默认开在上方），所以折叠/展开只改变尺寸与沉入量，`place` 原点一动不动——旧模型「`place` 指当前可见元素 + `placedBox` 锚角换算」正是跳位的来源，已删除。横向只夹紧不翻转，纵向的开合方向在展开时定下（`cardBelow`）并在拖动中冻结，避免越过阈值那一下整块瞬移。
- 位置与贴边方向写入 `chrome.storage.local` 的 `panelPlace`（去抖 200ms，只存 `{ left, top, dock }`），跨页面、跨重新加载保持；`applyPlace()` 把结果反映到 `panelHost` 的 `data-dock` / `data-left` / `data-top`（夹具测试读这三个属性，配合未变换的 `offsetWidth/offsetHeight` 判断贴边那条边是否真的钉在可视区上，以及圆球是否真的收成 40px）。
- `panelHost` 本身 `pointer-events: none`，只有卡片和胶囊接收事件——贴边后胶囊虽沉进边缘，也不会挡住页面点击。

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

商店文案与隐私政策见 [`docs/permission-justifications.md`](docs/permission-justifications.md)、[`docs/privacy-policy.md`](docs/privacy-policy.md)。下载判定所依据的协议标准与现实实现见 [`DOWNLOAD-STANDARDS.md`](DOWNLOAD-STANDARDS.md)。

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

### 11.1 门禁与发布流水线 / Gate and release pipeline

- `node scripts/check.mjs` = validate + 四个单元测试 + 夹具全量；任一步失败即非零退出。**push 之前必须全绿**。
  `--no-fixtures` 只给确实没有浏览器的环境：此时捕获行为未被验证，不能作为发布依据。
- `.githooks/pre-push` 在本地执行同一条门禁。启用是维护者的一次性动作：`git config core.hooksPath .githooks`
  （仓库里的任何脚本都不改 git 配置）；PATH 没有 node 时先 `export OPENNDM_NODE=<node.exe>`。
- 发布**手动触发**（`.github/workflows/release.yml`）：定位 Chrome → 读 `manifest.json` 版本 → 门禁 →
  `scripts/package.mjs` 出 zip → 解包该 zip 后用 Chrome `--pack-extension --pack-extension-key` 出 crx
  （保证 crx 与 zip 内容一致）→ 按 `v<manifest 版本>` 创建/更新 GitHub Release。门禁不过就没有产物，也没有 Release。
- crx 需要仓库 secret `CRX_PRIVATE_KEY`（PEM 原文或它的 base64）。缺省时跳过 crx 并在 Release 正文注明。
  私钥不入库，且**扩展 ID 由这把密钥唯一决定**——换 key 等于换扩展。
- 版本唯一来源是 `manifest.json`；`package.json` 由 `validate.mjs` 校验一致，Release tag 就是 `v` + 该版本。

---

## 12. 测试

### 单元/集成测试（`npm test`，无浏览器）

| 文件 | 覆盖 |
| --- | --- |
| `tests/background.test.mjs` | 消息路由、状态、设置归一化 |
| `tests/rules.test.mjs` | `decideCapture()` 的正反例、`serializeRequestBody()` 的请求体上限（约 36 条） |
| `tests/capture.test.mjs` | 用假的 `chrome.*` 驱动完整捕获链（网络路径、兜底、取消、面板、绕过） |
| `tests/package.test.mjs` | 打包文件清单与可复现性 |

`capture.test.mjs` 通过 `globalThis.chrome = {...}` 模拟 API，用 `FakeWebSocket` 记录发往 NDM 的消息，并用 `events.*` 手动触发监听器。

### 推送门禁（`npm run check`）

`scripts/check.mjs` 依次跑 validate、四个单元测试、`web-test.mjs --fixtures`，任一步失败即非零退出；
输出只打印每步结论，失败时才回显该步末尾日志（`--verbose` 打印全部）。见 11.1。

### 网页冒烟测试（`npm run test:web`，需要浏览器与网络）

- 用临时 profile 启动 Chrome/Edge，通过 CDP `Extensions.loadUnpacked` 加载扩展（Chrome 137+ 品牌版已忽略 `--load-extension`）。
- 把扩展复制到临时目录，并把 `DEFAULT_SETTINGS.ndmPort` 改写为假 NDM 的端口，避免碰本机 NDM。
- 假 NDM 是一个最小 WebSocket 服务，只记录消息、不应答下载。
- 逐个打开免登录站点（百度、新浪、网易、腾讯网、知乎、豆瓣、36氪、CSDN、博客园、B 站、爱奇艺、京东），停留 N 秒，读取资源数与标题确认页面确实加载，再关闭。
- 有捕获即失败（打印 URL 与类型）；页面未加载标为「跳过」且不计入结论。

```bash
npm run test:web -- --seconds 7 --browser edge --headed --filter 知乎
```

### 夹具测试（`npm run test:fixtures`，需要浏览器，**不需要网络**）

站点冒烟测试只能证明「没多抓」，夹具测试证明「该抓的也抓到了」：`scripts/fixtures.mjs` 起一个本地 HTTP 服务，
提供测试页与一组响应头/状态码各异的端点，用 CDP 驱动真浏览器逐个场景操作，再断言假 NDM 收到的消息条数与字段内容。
方向是双向的：`count: [1, 1]` 要求恰好一条，`count: [0, 0]` 要求一条都不许有。

| # | 场景 | 预期 |
| --- | --- | --- |
| 1 | zip 直链点击导航 | 捕获 1 条（`normal`，headers 或 downloads 兜底） |
| 2 | POST 表单提交下载 | 捕获 1 条，含 `1:POST` 与 `__0NeatPostData9__:` 请求体 |
| 3 | 直接导航到 zip | 捕获 1 条 |
| 4 | `application/octet-stream` 无扩展名导航 | 捕获 1 条（`forced-download`） |
| 5 | `Content-Disposition` 附件、URL 无扩展名 | 捕获 1 条 |
| 6 | HTML 但服务器标记为附件 | 捕获 1 条 |
| 7 | 视频页加载 + `<video>` 取元数据/206 | 不发送（只进面板） |
| 8 | XHR 取回图片 | 不发送 |
| 9 | RFC 2047 编码文件名附件 | 不发送（留给浏览器） |
| 10 | m3u8 清单 | 捕获 1 条，`6:hls` |
| 11 | 页面 `blob:` 下载 | 完全不发（断言不限 URL 前缀） |
| 12 | gzip 压缩的 zip 附件 | 捕获 1 条，但报文里**不得有 `7:` 行**（`notMatch` 按整行前缀判定） |
| 13 | 请求体超过 96KB 的 POST 下载 | 完全不发（既不能发半截体，也不能被兜底路径当 GET 重取） |
| 14 | 点击后经 302 才到 zip | 恰好 1 条，且中间 URL `/redirect-c14.zip` 不得出现 |
| 15 | CDP 真鼠标全流程：折叠态检查 → 点胶囊展开 → 点 ⌄ 收起 → 再展开 → 拖卡片到右边缘（自动收起并贴边）→ 悬停滑出 → 移开再沉回 → 点它脱离并展开 → 拖胶囊到左边缘 → 点它展开 → 拖卡片到下边缘 → 逐点采样两块探出矩形 → 重新加载 → 点圆球展开 → 点卡片内部不收回 → 点网页其他地方收回成胶囊 → 点 ⌄ 收起 | 三态互斥每一步都成立：折叠态只有胶囊（图标 + 徽标，图标中线与胶囊中线相差 ≤1.5px）；展开态只有卡片且四边完整落在**不含滚动条的可视区**内、胶囊不可见；点 ⌄ 后 `left`/`top` 逐像素不变；贴边态 `dock` 正确、圆球 `offsetWidth×offsetHeight` = 40×40、卡片不再占布局、屏内正好露 30px 且图标完整落在其中并居中；悬停判定**只随指针位置改变**且**只有落到屏内那一条才弹**——落在"探出后才有"的那半截上必须仍贴边、落在露出的那一条上必须探出、迟滞带内与原地 1px 抖动都不翻、静止连续采样恒定（旧实现挂在元素自己的 `pointerenter/leave` 上，正是这里无限弹出/收起）；重新加载后 `dock`、钉住的底边与自由轴 `left` 不变；点卡片内部面板仍在；点网页其他地方与点 ⌄ 都收回成胶囊**并吸回原来那条边**（`dock` 与底边、`left` 都对得上），收回后圆球仍可再展开；整个过程**一条消息都不发** |

```bash
npm run test:fixtures -- --filter 视频      # 只跑匹配的场景
node scripts/web-test.mjs --fixtures --browser edge --verbose
```

场景的 zip 由 `makeZip()` 现场构造（STORE 条目 + 手写 CRC32），保证浏览器按真实压缩包处理；
每个场景使用独立 URL，避免 `recentSent` 去重把后一个场景吞掉。断言逻辑改动后建议做一次故障注入
（把某条预期改成 `[0, 0]`）确认测试确实会失败。

---

## 13. 版本号

- 写在 `manifest.json` 的 `version`，并同步到 `package.json`；`scripts/validate.mjs` 校验一致（`npm run check` 是完整门禁，见 11.1）。
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
- 捕获诊断：设置页 → **诊断 → 复制捕获日志**，或 Service Worker 控制台里的 `[OpenNDM] capture` 行。每条记录包含 `source`（`headers` / `fallback` / `manual`）、`tabId`、资源类型、`referrer`、`pageUrl`，保存在 `chrome.storage.local` 的 `captureLog`（环形 60 条，写入失败不影响捕获）。
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
  check.mjs                   push gate: validate + the four unit suites + the whole fixture run
  package.mjs                 reproducible release zip
  web-test.mjs                real-browser smoke test with a fake NDM
  fixtures.mjs                local download-scenario server + per-scenario assertions (used by web-test --fixtures)
  make_icons.py               icon generator
.github/workflows/release.yml manual-release pipeline (gate → zip → crx → GitHub Release)
.githooks/pre-push            local push gate, enabled by `git config core.hooksPath .githooks`
docs/                         privacy policy, store permission justifications, build notes
DOWNLOAD-STANDARDS.md         download standards and real-world behaviour (the reference behind the rules)
ROADMAP.md                    development plan, capability ceiling, permanent never-do list
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

1. `decideCapture({ url, method, type, statusCode, contentType, contentDisposition, contentLength, contentRange, captureEnabled, captureMedia, ndmConnected, blocked, bypass })`.
2. On rejection: if the reason is in `BROWSER_ONLY_REASONS` (`rfc2047-filename`, `post-body-too-large`), record the URL in `browserOnlyUrls` (`LIMITS.browserOnlyMs`, default 15 s) so the fallback does not forward it; otherwise return. Both reasons mean only the browser can finish the download: NDM cannot decode an RFC 2047 name, and an oversize POST body leaves nothing replayable — the fallback would re-fetch it as GET.
3. On acceptance with `media`/`hls` and `showMediaPanel`: push to `mediaByTab` and the content script (**no automatic send**).
4. Media decided for a non-`main_frame` request also returns early (the panel only serves the current page).
5. Everything else: fetch cookies → `createPayload()` → register `inflightCaptures` → `sendToNdm({ expectBrowserDownload: true })`.

After a successful `sendToNdm()`, the URL is recorded in `recentSent` (12 s dedupe) and `pendingCancel` (15 s, used by the fallback to cancel the browser copy), and `STATE_CHANGED` is broadcast.

### 4.2 Browser download fallback (`downloads.onCreated`)

Checked in order; the first hit returns:

1. `byExtensionId === chrome.runtime.id` (started by us).
2. Not `http(s)`.
3. URL or `finalUrl` is a DASH fragment (`M4S/CMFV/CMFA/CMFT`).
4. `browserOnlyUrls` hit (RFC 2047 filename).
5. Inside the Ctrl bypass window.
6. `pendingCancel` / `inflightCaptures` / `recentSent` hit: already sent by the network path, so cancel the browser copy **even when it has no tab** and return.
7. NDM not connected → return.
8. **`tabId < 0` or not an integer**: no tab and nothing sent, so this is an old task the browser restored or resumed; do not forward it.
9. Site blocked.
10. `seenHeaderUrls` hit: wait up to 600 ms for the network path; if `pendingCancel` appears meanwhile, cancel and return.
11. Re-check with `decideCapture({ type: 'main_frame', ... })`; if it does not pass, give up.
12. `targetUrl = item.finalUrl || item.url` → send → cancel the browser download and `chrome.downloads.erase()` it.

> Step 11 matters: a browser download event is not proof of user intent and must pass the same rules.
> Step 6 matters just as much: cancellation depends only on "was this already sent to NDM", not on having a tab; a missed cancel leaves one copy in NDM and another in the browser.

### 4.3 Manual path

The **Download with NDM** context menu item (`MSG.DOWNLOAD_URL`) bypasses `decideCapture`, but still honours the site blocklist, Ctrl bypass, "NDM not connected", and port validation. It exists for links whose page is gone or that the rules cannot recognise.

## 5. `decideCapture()` rules

The **standards and real-world behaviour behind each branch** (RFC 9110/6266/8187/2047, the limits of `<a download>`, fetch+blob downloads, Range/206, `Sec-Fetch-*`, MV3 capabilities, and the G1–G12 gap list with its current status) are recorded in [DOWNLOAD-STANDARDS.md](DOWNLOAD-STANDARDS.md). Check it before changing a rule.

Input (`src/lib/rules.js`):

| Field | Meaning |
| --- | --- |
| `url` | must be http/https |
| `method` | GET/POST only |
| `statusCode` | 200 / 203 / 206 (206 only for explicit attachments) |
| `type` | `main_frame`, `sub_frame`, `object`, `media`, `xmlhttprequest`, `other` |
| `contentType` / `contentDisposition` | normalised response headers |
| `contentLength` / `contentRange` | size inference |
| `contentEncoding` | for compressed responses (gzip/br/deflate) the size is unknown: `Content-Length` describes encoded bytes, so `size` becomes 0 |
| `postBodyTooLarge` | POST body above the 96KB cap: a partial body is never replayed |
| `captureEnabled` / `captureMedia` / `ndmConnected` / `blocked` / `bypass` | external state |

Output: `{ capture, kind, reason, ext, size, filename, contentType }`.

### Order and rejection reasons

| Step | Condition | Result |
| --- | --- | --- |
| 1 | missing context / disabled / not connected / blocked / bypassed | `invalid-context` `capture-disabled` `ndm-disconnected` `site-blocked` `user-bypass` |
| 2 | not http(s), method, POST body above 96KB, status | `not-http` `method` `post-body-too-large` `status` |
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
| `7:` | file size in bytes, optional; omitted when the response carries a non-`identity` `Content-Encoding`, because `Content-Length` then describes encoded bytes |
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
| `panelPlace` | local | the pill's origin and docked side `{ left, top, dock }` (the card is its popover and its offset is computed, so nothing else is stored); a UI preference only — failing to read or write it must not affect capture |
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
- **Free drag**: the `.head` title bar and the pill both drag (pointer events); the position is clamped to the client box and, on release, snaps to whichever edge the *union of card and pill* is within `PLACE_SNAP` (24 px) of. The union is required: the card always opens above the pill, so measuring the pill alone would make only two of the four edges reachable by that gesture.
- **Placement uses the scrollbar-free client box**: horizontally `documentElement.clientWidth` (`viewportWidth()`), vertically `clientHeight`. `window.innerWidth` counts classic scrollbar tracks, and Windows' default "scrollbars take up space" thin bars reserve width too (measured 15 px), so placing by it parks the card or the pill exactly under the bar. The expanded card is capped at `min(430 px, 80vh)`: a card taller than the client box makes the clamp's two bounds contradict each other, and both the icon and the card end up unreachable.
- **Edge docking (the pill is the only thing that docks)**: `place = { left, top, dock }` is *always* the pill's top-left. `applyPlace()` pins the docked axis to the client-box edge and then sinks the pill with `translate(calc(-100% + DOCK_PEEK))` (left/top) or `translate(calc(100% - DOCK_PEEK))` (right/bottom) — mind the direction: a left dock leaves the element's **right** 30 px on screen. That is why `DOCK_PEEK` (30) has to be at least the ball's centre 20 plus half the icon 8.5, so the icon stays whole; the pill also morphs into a 40 px circle and the count badge tweens away. While peeked, the clamp uses the full `PILL_FLOAT_W` width or the slid-out half hangs off the edge. Clicking the ball undocks first and then expands, and starting to drag also undocks; folding a card that was opened from an edge re-docks it to **that same edge** (`dockResume`, below). The card never sinks, so there is never a half-cut card on screen.
- **The peek decision is two static rectangles, not the element's own hover**: `hoverRects()` derives both only from `place`, the docked side and the client box, and a passive `pointermove` on window hit-tests the pointer against them — `enter` is **the band the parked ball leaves on screen** (`DOCK_PEEK × DOCK_SIZE`, docked axis pinned to the edge), `keep` is **the whole pill once slid out** (`PILL_FLOAT_W` × height), each widened by `HOVER_MARGIN` (8 px). The pill's own `pointerenter/pointerleave` cannot be used: the pill moving re-runs the hit test, so peek → leave → park → enter again feeds itself, which is the endless in/out loop near the edge. Restricting `enter` to the visible band matters just as much: the old zone was the slid-out pill, so the ball popped out while the pointer was still tens of pixels from the edge — what the user reported as "it peeked before I got there". Parking needs the pointer fully outside `keep` plus 8 px, so wandering over the ball and 1 px of tremor flip nothing. A fresh snap or fold sets `hoverArmed` false — the pointer is resting inside the zone that was just created and would peek the ball straight back out — and it re-arms once the pointer has fully left and returned.
- **Folding returns to the edge it came from**: clicking a docked pill records `place.dock` in `dockResume`, and `setPanelCollapsed(true)` (the ⌄ icon or a click elsewhere on the page) sees an empty `dock` with a pending `dockResume`, re-pins that side, reapplies placement and persists it — otherwise the pill drifts at wherever the undock left it and reads as "I opened it and lost the docking". A real drag clears `dockResume`: the user moved the pill, so there is no edge to go back to.
- **Clicking elsewhere folds the card back**: a capture-phase `pointerdown` on `document` (page code cannot swallow it with `stopPropagation`) folds the open card into the pill. `event.composedPath()` decides what counts as "inside" — the panel and the toast each live in their own shadow host, so comparing `event.target` alone cannot see cross-shadow membership. Ignored during a drag and for non-primary buttons.
- **Expand/fold keeps the origin**: the card is a popover of the pill and `applyCardAnchor()` computes its offset (right-aligned, opening above by default), so folding and unfolding only change size and sink depth — `place` never moves. The old model, where `place` meant "the top-left of whatever is visible" and `applyPlace()` converted anchors through the last placed size, was the source of every jump and is gone. Horizontally the card is clamped, never flipped; the vertical side is chosen when it opens (`cardBelow`) and frozen during a drag, so nothing teleports when the pointer crosses a threshold.
- Position and docked side persist in `chrome.storage.local` under `panelPlace` (200 ms debounce, only `{ left, top, dock }`), surviving navigation and reload; `applyPlace()` mirrors the result into `panelHost` as `data-dock` / `data-left` / `data-top`, which is what the fixture test reads (together with the untransformed `offsetWidth/offsetHeight`, to prove the docked edge really is pinned to the client box and the pill really shrank to 40 px).
- `panelHost` itself is `pointer-events: none` — only the card and the pill take input, so a pill sunk into an edge never blocks page clicks.

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

Store copy and privacy policy: [`docs/permission-justifications.md`](docs/permission-justifications.md), [`docs/privacy-policy.md`](docs/privacy-policy.md). The protocol standards and real-world behaviour behind the capture rules: [`DOWNLOAD-STANDARDS.md`](DOWNLOAD-STANDARDS.md).

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

### 11.1 Gate and release pipeline

- `node scripts/check.mjs` = validate + the four unit suites + the whole fixture run; any failing step exits
  non-zero. **Push only on a green gate.** `--no-fixtures` exists for browserless environments, but then
  capture behaviour is unverified and must never be a release basis.
- `.githooks/pre-push` runs the same gate locally. Enabling it is a one-time maintainer action:
  `git config core.hooksPath .githooks` (no script in this repo touches git config); if PATH has no node,
  export `OPENNDM_NODE=<node.exe>` first.
- Releases are **manually triggered** (`.github/workflows/release.yml`): locate Chrome → read the
  `manifest.json` version → run the gate → build the zip with `scripts/package.mjs` → unpack that same zip and
  pack a crx with Chrome `--pack-extension --pack-extension-key`, so the crx carries exactly the zip's files →
  create or update the GitHub Release tagged `v<manifest version>`. A red gate yields neither artifacts nor a release.
- The crx needs repo secret `CRX_PRIVATE_KEY` (the PEM itself or its base64). Without it the crx step is skipped
  and the release notes say so. The key never enters the repo and **it alone determines the extension ID** —
  a new key means a different extension.
- `manifest.json` owns the version; `validate.mjs` keeps `package.json` in sync and the release tag is `v` + that value.

## 12. Tests

### Unit/integration tests (`npm test`, no browser)

| File | Coverage |
| --- | --- |
| `tests/background.test.mjs` | message routing, state, settings normalisation |
| `tests/rules.test.mjs` | positive and negative `decideCapture()` cases plus the POST body cap (about 36) |
| `tests/capture.test.mjs` | full capture chain driven by fake `chrome.*` APIs (network path, fallback, cancel, panel, bypass) |
| `tests/package.test.mjs` | archive file list and reproducibility |

`capture.test.mjs` installs `globalThis.chrome = {...}` to mock the APIs, records messages sent to NDM with a `FakeWebSocket`, and fires listeners through `events.*`.

### Push gate (`npm run check`)

`scripts/check.mjs` runs validate, the four unit suites and `web-test.mjs --fixtures` in order and exits non-zero on the first
failure. Each step prints only its verdict; the tail of a failing step is echoed (`--verbose` prints everything). See 11.1.

### Web smoke test (`npm run test:web`, needs a browser and network)

- Starts Chrome/Edge with a throwaway profile and loads the extension through the CDP `Extensions.loadUnpacked` command (branded Chrome 137+ ignores `--load-extension`).
- Copies the extension to a temp directory and rewrites `DEFAULT_SETTINGS.ndmPort` to the fake NDM's port, so the real NDM is never touched.
- The fake NDM is a minimal WebSocket server that records messages and never downloads anything.
- Opens login-free sites one by one (Baidu, Sina, NetEase, QQ, Zhihu, Douban, 36Kr, CSDN, cnblogs, Bilibili, iQiyi, JD), waits N seconds, reads the resource count and title to confirm the page loaded, then closes it.
- Any capture fails the run (URL and kind are printed); pages that did not load are marked as skipped and excluded from the verdict.

```bash
npm run test:web -- --seconds 7 --browser edge --headed --filter 知乎
```

### Fixture test (`npm run test:fixtures`, needs a browser, **no network**)

The site smoke test can only prove "nothing extra was captured"; the fixture test proves the expected
captures actually happen. `scripts/fixtures.mjs` serves a local page plus endpoints with varied response
headers/status codes, drives a real browser through CDP case by case, and asserts how many messages the
fake NDM received and what they contain. Both directions matter: `count: [1, 1]` requires exactly one
message, `count: [0, 0]` requires none at all.

| # | Scenario | Expectation |
| --- | --- | --- |
| 1 | click a direct zip link | one capture (`normal`, via headers or the downloads fallback) |
| 2 | form POST download | one capture with `1:POST` and a `__0NeatPostData9__:` body |
| 3 | navigate straight to a zip | one capture |
| 4 | extensionless `application/octet-stream` navigation | one capture (`forced-download`) |
| 5 | `Content-Disposition` attachment, extensionless URL | one capture |
| 6 | HTML served as an attachment | one capture |
| 7 | video page: load + `<video>` metadata/206 | not sent (panel only) |
| 8 | image fetched by XHR | not sent |
| 9 | RFC 2047 encoded attachment filename | not sent (left to the browser) |
| 10 | m3u8 playlist | one capture with `6:hls` |
| 11 | page `blob:` download | nothing sent at all (URL prefix not restricted) |
| 12 | gzip-encoded zip attachment | one capture, but **no `7:` line** (`notMatch` compares whole line prefixes) |
| 13 | POST download whose body exceeds the 96KB cap | nothing sent (no partial body, and the fallback must not re-fetch it as GET) |
| 14 | link that reaches the zip through a 302 | exactly one capture, and the intermediate `/redirect-c14.zip` URL never appears |
| 15 | full CDP mouse flow: check the collapsed pill, click it to expand, fold with ⌄, expand again, drag the card onto the right edge (it folds and docks itself), hover it out, leave, click it to undock and expand, drag the pill to the left edge, click it open, drag the card to the bottom edge, then sample the two peek rectangles point by point, reload, click the ball to expand, click inside the card, click elsewhere on the page, fold with ⌄ | all three states stay mutually exclusive at every step — collapsed is the pill alone (icon + badge, the icon's mid-line within 1.5 px of the pill's), expanded is the card alone with all four edges inside the **scrollbar-free client box** and the pill invisible, folding keeps `left`/`top` pixel-identical, and docked reports the right `dock`, a 40×40 `offsetWidth×offsetHeight` ball, no card left in the layout, exactly 30 px on screen with the whole icon inside it and centred; the hover decision follows **the pointer only** and peeks **only on the band the parked ball leaves on screen** — a point that only exists once slid out must stay parked, a point on the visible band must slide out, the dead band and 1 px tremor flip nothing and samples taken with the pointer held still must be constant (the old wiring on the element's own `pointerenter/leave` looped peek/park forever here); after reload the `dock`, the pinned bottom edge and the free `left` come back unchanged; clicking inside the card leaves it open; clicking elsewhere and clicking ⌄ both fold it into the pill **and re-park it on that same edge** (matching `dock`, bottom edge and `left`), and the ball reopens afterwards — while the whole interaction **sends nothing** |

```bash
npm run test:fixtures -- --filter 视频      # only matching scenarios
node scripts/web-test.mjs --fixtures --browser edge --verbose
```

The zips are built on the fly by `makeZip()` (STORE entries, hand-written CRC32) so browsers treat them
as real archives; every scenario uses its own URL because `recentSent` dedupe would otherwise swallow the
next case. After changing assertion logic, do one fault injection (flip an expectation to `[0, 0]`) to
confirm the suite can actually fail.

## 13. Versioning

- Stored in `manifest.json` (`version`) and mirrored in `package.json`; `scripts/validate.mjs` verifies they match (`npm run check` is the full gate — see 11.1).
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
- Capture diagnostics: settings page → **Diagnostics → Copy capture log**, or the `[OpenNDM] capture` lines in the service worker console. Each entry records `source` (`headers` / `fallback` / `manual`), `tabId`, resource type, `referrer`, and `pageUrl`, kept in `chrome.storage.local` under `captureLog` (ring buffer of 60; a write failure never affects capture).
- Rejection reasons are listed in section 5; `not-download` usually means the rules did not recognise the file — use **Download with NDM** from the context menu to confirm it is a real file.

## 16. Trade-offs

- The NDM protocol has no filename field; names come from the server's `Content-Disposition` or the URL. The extension cannot force a different name.
- `blob:` downloads can only complete in the browser; when a page fetches a file and re-wraps it as a blob, NDM cannot learn the real filename, so those downloads stay in the browser.
- RFC 2047 encoded filenames are handed to the browser; the cost is that those downloads skip NDM.
- Old downloads the browser restores at startup have no originating tab and are never taken over.
- Media always goes to the panel only, which keeps ads, danmaku, and segments out of NDM.
