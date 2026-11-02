# Web 文件下载标准与实际实现 / Web file-download standards and real-world practice

<a id="chinese"></a>
**[English summary ↓](#english-summary)** · [开发文档](DEVELOPMENT.md) · [AGENTS.md](AGENTS.md)

本文是**判定规则的依据手册**：把「网页上的一个文件下载在协议层长什么样」查清楚，并逐条对应到本仓库现有实现（`file.js:line`）。
改 `decideCapture()` 分支、加夹具场景、或判断某个站点为什么漏抓/误抓时，先查本文。

- 与 [DEVELOPMENT.md](DEVELOPMENT.md) 的分工：那边写「本项目怎么做」；本文写「标准和真实世界怎么做」，并标出我们尚未覆盖的部分。
- 事实来源见文末 [参考资料](#参考资料)；RFC 小节号按 RFC 9110 / RFC 6266 / RFC 8187 现行文本核对过。
- 维护要求：**新增或修改捕获分支时，同步更新第 8 节差距表和第 9 节夹具矩阵。**

---

## 0. 十条结论（先读这个）

1. **`Content-Disposition` 不是 HTTP 标准的一部分。** RFC 9110 全篇没有这个头（表示头只有 `Content-Encoding` / `Content-Language` / `Content-Length` / `Content-Type`）；它由 **RFC 6266** 单独定义，且 RFC 6266 §1 明确说它「不属于 HTTP 标准」。即便服务器发了 `attachment`，具体下载行为仍由 UA 决定。
2. **文件名有三套写法，只有一套可靠**：`filename="…"`（ASCII，百分号解码各家不一致）、`filename*=UTF-8''…`（RFC 8187，唯一规范做法）、`=?UTF-8?B?…?=`（RFC 2047，来自邮件头，**在 HTTP 里非法**，Chrome 不解码，会原样变成文件名）。NDM 同样不解码第三种 → 见 [src/lib/rules.js:133](src/lib/rules.js#L133)。
3. **`<a download>` 只对同源 URL（及同源 `blob:`/`data:`）生效**，跨源时属性被忽略、退化成普通导航；反过来，`download` 能覆盖 `Content-Disposition: inline`，但 CD 里的 `filename` 又覆盖 `download` 的值。**这条链上没有任何网络层标记**，所以「页面明明在下载」而头里什么都没有的情况是标准行为，不是 bug。
4. **`fetch → Blob → createObjectURL → <a download>` 是当下主流的大文件/鉴权文件写法**，网络层只表现为一个 XHR，真实文件名和扩展名**只存在于 DOM**；`blob:`/`data:` 永远不会出现在 `webRequest` 里。我们拒绝 XHR 附件（[src/lib/rules.js:145](src/lib/rules.js#L145)）正是为了不重复下载 + 不下到错误名字。
5. **`Content-Length` 有两个坑**：`Transfer-Encoding: chunked` 时它不存在（长度未知）；`Content-Encoding: gzip/br` 时它表示**压缩后**字节数。Range 的字节偏移也作用于「编码后的表示」，把压缩长度当原始长度用于分段会直接 416。
6. **服务器可以合法地忽略 `Range` 并回 200**（RFC 9110 §14.2）；206 必须带 `Content-Range`（§15.3.7），416 必须带 `Content-Range: bytes */<total>`（§15.5.17）；安全的续传校验只有 `If-Range` + `ETag`/`Last-Modified`（§13.1.5）。
7. **`application/force-download`、`application/download`、`application/x-download`、`application/binary`、`binary/octet-stream`（S3 遗留）都不在 IANA 注册表里**，浏览器并不认识它们——强制下载的效果实际来自 `Content-Disposition`。我们的 `FORCED_DOWNLOAD_MIMES`（[src/lib/constants.js:96](src/lib/constants.js#L96)）是**经验表**（服务端确实这么写），不是标准表，别把它当规范引用。
8. **`Sec-Fetch-*` 里没有 `download` 这个 destination 值**；`Sec-Fetch-User: ?1` 只证明「用户手势触发的导航」，无法区分「点了个网页」与「点了个 .zip 链接」。因此「必须顶层导航」这条规则（[src/lib/rules.js:186](src/lib/rules.js#L186)）的标准等价物只是 `Sec-Fetch-Dest: document` + `Sec-Fetch-Mode: navigate`，加上 `?1` 只能提高置信度，不能替代内容判断。
9. **MV3 下观察式 `webRequest`（含 `onHeadersReceived`）依然可用，`webRequestBlocking` 对普通扩展不可用**——这正是「扩展只做判定、下载器自己重取」这个架构的合规前提。我们不改包体、不拦请求，符合该约束。
10. **`resourceType` 没有 `download` 值**；`requestId` 跨重定向/鉴权挑战保持稳定；`(fromCache)` 的响应可能**完全不带头**。Chrome 决定「下载还是渲染」发生在 `onHeadersReceived` **之后**，所以我们看到头时，浏览器自己还没决定。

---

## 1. 标准谱系速查

| 事项 | 出处 | 关键点 | 本项目落点 |
| --- | --- | --- | --- |
| HTTP 语义、表示头、Range、状态码 | RFC 9110 | §8.3/8.4/8.6、§14、§15.3.7/15.5.17 | [src/lib/rules.js:76-95](src/lib/rules.js#L76-L95) |
| `Content-Disposition` | RFC 6266 | §4.1 `filename`、§4.2 `filename*`、§4.3 两个都给、§7 安全 | [src/lib/utils.js:92-110](src/lib/utils.js#L92-L110) |
| 扩展参数值 `charset'lang'value` | RFC 8187（取代 5987） | §3.2 `ext-value`，非 ASCII 必须百分号编码 | `filenameStar`：[src/lib/utils.js:100-106](src/lib/utils.js#L100-L106) |
| 邮件式编码字 | RFC 2047 | 仅用于 MIME 头，HTTP 参数里非法 | 拒绝：[src/lib/rules.js:221-226](src/lib/rules.js#L221-L226) |
| `download` 属性、命名净化 | WHATWG HTML | 同源限制；`/`、`\` → `_`；CD 名优先 | 仅用于绕过提示：[src/content/catcher.js:130-136](src/content/catcher.js#L130-L136) |
| Fetch Metadata | W3C webappsec-fetch-metadata | `Sec-Fetch-Dest/Mode/Site/User` | **未使用**（见第 8 节 G3） |
| MIME 嗅探、`nosniff` | MIME Sniffing Standard / WHATWG Fetch | `nosniff` 只限制 script/style 等目的 | `NON_DOWNLOAD_MIMES`：[src/lib/constants.js:72](src/lib/constants.js#L72) |
| HLS | RFC 8216（正在被 draft-pantos-hls-rfc8216bis 取代） | `#EXTM3U`/`#EXTINF`/`#EXT-X-STREAM-INF`/`#EXT-X-BYTERANGE` | `hls-playlist`：[src/lib/rules.js:123-127](src/lib/rules.js#L123-L127) |
| DASH / fMP4 | ISO 14496-12/14 + `application/dash+xml` | init 段（`ftyp`+`moov`）单独无意义 | `STREAM_SEGMENT_EXTENSIONS`：[src/lib/constants.js:67](src/lib/constants.js#L67) |
| MSE / `blob:` | W3C media-source + File API URL | 内存中的源，无 HTTP 层对象 | 设计上不接管：[src/lib/utils.js:15-22](src/lib/utils.js#L15-L22) |
| 扩展侧观察能力 | Chrome `webRequest`（MV3） | 观察式可用、阻塞式不可用 | [src/background.js:692-755](src/background.js#L692-L755 |
| 下载项元数据 | Chrome `downloads` | `finalUrl`/`totalBytes`/`dangerType`，**无请求头** | 兜底路径：[src/background.js:1036-1200](src/background.js#L1036-L1200) |

---

## 2. HTTP 语义层：服务器写了什么才算「这是文件」

### 2.1 `Content-Disposition`（RFC 6266）

- 语法 `disposition-type := "inline" | "attachment" | extension-token`；`attachment` = 建议本地保存，`inline` = 可由 UA 按表示类型自由渲染。
- §5：接收方**优先**用能理解的 `filename*`；§4.3：为了兼容**两个都要给**（`filename="euro.zip"; filename*=UTF-8''%E6%AC%A7.zip`）。
- §6/§7：服务器给的名字是**不可信输入**——必须去掉路径分隔、控制字符与文件系统保留名。我们对应 `safeFilename()`（[src/lib/utils.js:124](src/lib/utils.js#L124)）。
- 现实分歧：MDN 明确「`<a download>` 被采纳时覆盖 `inline`，但 CD 的 `filename` 覆盖 `download` 的属性值」；且**普通 `filename` 里的百分号转义处理不一致（Firefox/Chrome 解码，Safari 不解码）**，所以 `filename="a%20b.zip"` 这种服务端自作聪明的写法，各家名字不同。
- **不要把它传给 NDM。** 响应头里的 CD 是「浏览器该怎么做」的指令，NDM 会当请求头回发给服务器，导致 416 / 命名错误——见 [src/lib/ndm.js:40-41](src/lib/ndm.js#L40-L41) 与 AGENTS.md 硬性约束。

### 2.2 文件名编码的三条路

| 写法 | 标准 | 浏览器行为 | NDM/我们的处理 |
| --- | --- | --- | --- |
| `filename="report.pdf"` | RFC 6266 §4.1 | 直接采用；百分号是否解码不统一 | 采用 |
| `filename*=UTF-8''%E4%B8%AD%E6%96%87.zip` | RFC 6266 §4.2 + RFC 8187 §3.2 | 统一解码，优先于 `filename` | `filenameStar` 优先（[src/lib/rules.js:99](src/lib/rules.js#L99)） |
| `filename="=?UTF-8?B?6YKu5Lu2LnppcA==?="` | RFC 2047（MIME 头专用，HTTP 非法） | Chrome 原样保留 → 乱名；Firefox 历史上有专门解码 | **拒绝接管**：`rfc2047-filename`（[src/lib/rules.js:133](src/lib/rules.js#L133)）+ `browserOnlyUrls`（[src/background.js:889](src/background.js#L889)） |

RFC 2047 主要来自非标准邮件/网盘实现（Gmail 附件名是常见例子）。我们的取舍是：**这类下载留在浏览器**，因为只有浏览器能保留正确名字；NDM 只会按 URL 存成乱名。这是「宁可漏拦」的一个具体实例。

### 2.3 `Content-Type` 与「强制下载 MIME」的真相

- 注册的、有意义的：`application/octet-stream`（RFC 2045/2046，未知二进制）、`application/vnd.apple.mpegurl`、`application/dash+xml`。
- 未注册但**服务端确实在发**的：`application/force-download`、`application/download`、`application/x-download`、`application/binary`、`binary/octet-stream`（S3 老配置）。浏览器并不因这些类型而下载，起作用的仍是 CD 或嗅探。
- 由此推论：`FORCED_DOWNLOAD_MIMES` 命中只能当作「服务端想让你下载」的弱证据，我们要求它必须来自顶层导航（[src/lib/rules.js:197-199](src/lib/rules.js#L197-L199)）才放行，这是对的。
- 反面教材：`application/octet-stream` 也常被 CDN 用来掩盖**分片**，所以要按 URL 扩展名再拦一次（[src/lib/rules.js:165-168](src/lib/rules.js#L165-L168）。

### 2.4 大小的三个坑

| 情况 | 标准 | 后果 | 我们 |
| --- | --- | --- | --- |
| `Transfer-Encoding: chunked` | RFC 9110 §8.6（长度前置才可有 Content-Length） | 长度未知，进度条无意义 | `contentLength` 为 `undefined` → `size=0`，不发 `7:`；`empty-file` 只在头存在且为 0 时才拒（[src/lib/rules.js:198-201](src/lib/rules.js#L198-L201） |
| `Content-Encoding: gzip/br` | MDN Content-Encoding：此时 `Content-Length` 指**编码后**大小 | 报给 NDM 的 `7:` 偏大偏小都可能；分段/续传偏移全错 | 已读并处理：压缩响应的 `size` 强制为 0，协议上不发 `7:`（[src/lib/rules.js:91-97](src/lib/rules.js#L91-L97)）；不自己解压（G1 已闭环） |
| 206 分片 | RFC 9110 §14.4 `Content-Range: bytes 0-999/4096` | 单片长度 ≠ 总长度 | `totalSizeFromRange()` 取 `/` 后的总数取 max（[src/lib/utils.js:149](src/lib/utils.js#L149)，[src/lib/rules.js:90-97](src/lib/rules.js#L90-L97)） |

### 2.5 Range / 206 / 416

- `Range: bytes=0-99` / `bytes=99-` / `bytes=-100`；多范围会回 `multipart/byteranges`（§14.6），**实现度差**，遇到就当异常。
- `Accept-Ranges: bytes|none`（§14.3）只描述服务端对 GET/HEAD 的支持，不禁止客户端发 `Range`。
- 忽略 `Range` 直接回 200 合法 → 假设自己收到 206 的分段下载器会**静默拼接出损坏文件**。
- 我们只在「明确附件」时接受 206（[src/lib/rules.js:104](src/lib/rules.js#L104) `partial-response`），媒体 206 一律拒（`:177` `partial-media`，因为那基本是播放器探测）；请求头里的 `Range:` 不转发，续传由 NDM 自己发起。

### 2.6 状态码

白名单 200/203/206（[src/lib/rules.js:76-78](src/lib/rules.js#L76-L78)）。注意 **203 = 代理改写过的响应**（§15.3.4），其 `Content-Length`/CD 可能不是源站值——接受它是有意的宽松，见第 8 节 G7。3xx 不在白名单：重定向链上的中间响应不该被当文件。

---

## 3. 页面侧：真实世界的下载写法与它们的网络指纹

| # | 触发写法 | method / `Sec-Fetch-*` | Chrome `resourceType` | 响应头可见性 | 朴素规则会怎样 | 本项目行为 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `<a href="x.zip">` / `location.href` / `window.open` | GET，`dest=document`，`mode=navigate` | `main_frame` | 可见 | 把点开 `.js`/`.json`/`.pdf`/图片也当下载 | 靠 `NON_DOWNLOAD_MIMES`、`EXPLICIT_ONLY_EXTENSIONS`、`image-asset` 拦下 |
| 2 | `<a download>`（同源） | 同上 | `main_frame`/`other` | 可见，但**属性名不在协议上** | 服务端发 `inline` 时无 CD → 漏抓，或按 URL 起错名 | 漏抓（可接受）：文件名也不会上协议线 |
| 3 | `<a download>`（跨源） | 同上 | `main_frame` | 属性被忽略 → 退化成导航 | 以为是下载 | 按导航规则判定，与浏览器实际一致 |
| 4 | 隐藏 iframe 连发 | GET，`dest=iframe` | `sub_frame` | 可见 | 批量误下 + 触发 Chrome 多下载限流 | `not-navigation` 拒绝（[src/lib/rules.js:186](src/lib/rules.js#L186)） |
| 5 | `<form method=post target=_blank>` 回附件 | POST，`dest=document` | `main_frame` | 可见 | 重放时退化成 GET → 405/空报告 | 取 `requestBody` 并以 `__0NeatPostData9__:` 交给 NDM（[src/lib/ndm.js:58-64](src/lib/ndm.js#L58-L64)） |
| 6 | `fetch`/XHR → `Blob` → `createObjectURL` → `<a download>` | `dest=empty`，`mode=cors` | `xmlhttprequest` | 可见但**无文件语义**（URL 常是 `/api/export`） | 把一次 API 调用当下载，且下第二遍 | `xhr-fetch` / `js-blob-download` 拒绝；真实名字只在 DOM |
| 7 | `fetch` + `ReadableStream` 分片并行 | 同上，常带 `Range:` → 多个 206 | `xmlhttprequest` | 可见 | 一片一条任务，N 份重复 | `partial-response` + `segment-url` + `recentSent` 去重 |
| 8 | StreamSaver.js（SW 伪造 CD） | 真实 fetch 是 `dest=empty` | `xmlhttprequest`/`other` | 文件名由页面凭空造 | 抓到无关 fetch | 不处理（正确：文件已在本地写出） |
| 9 | File System Access（`showSaveFilePicker`） | **根本没有 HTTP 下载** | — | — | 抓住前面的 fetch → 重复落盘 | 不处理（正确） |
| 10 | `blob:` / `data:` URL 下载 | 无网络请求 | 不进 `webRequest` | 不可见 | 以为漏了 | 设计上不接管（[src/lib/utils.js:15-22](src/lib/utils.js#L15-L22)） |
| 11 | 302/307 → CDN 签名 URL | GET | `main_frame` | 最终头的**域名已换**，Referer/Cookie 作用域跟着变 | 按原始 URL 命名、鉴权信息用错站点 | 兜底路径用 `finalUrl || url`（[src/background.js:1051](src/background.js#L1051)）；主路径不聚合重定向（差距 G6） |

**要点**：判定可用的信号只有响应头 + `resourceType` + URL 形状。`<a download>` 的属性值、DOM 里的真实文件名、`blob:` 内容，都在**协议层之外**，任何纯网络嗅探规则都抓不到——这不是实现缺陷，是标准边界。

---

## 4. 用户意图信号：Fetch Metadata

| 头 | 取值 | 用途 |
| --- | --- | --- |
| `Sec-Fetch-Dest` | `document` `empty` `image` `font` `script` `style` `object` `media` `worker` `serviceworker` `frame` `iframe` `video` `audio` `manifest` 等（**没有 `download`**） | 请求目的地 |
| `Sec-Fetch-Mode` | `navigate` `same-origin` `cors` `no-cors` `websocket` | 请求模式 |
| `Sec-Fetch-Site` | `same-origin` `same-site` `cross-site` `none` | 站点关系 |
| `Sec-Fetch-User` | 仅 `?1`，且只在**用户手势触发**的请求上出现，否则不发送 | 是不是用户主动点的 |

- 用户点下载链接 ≈ `Dest: document; Mode: navigate; User: ?1`；脚本发起的取回 ≈ `Dest: empty; Mode: cors`（**没有** `User`）。
- 这正好对应我们现有的两条规则：`not-navigation`（内容脚本之外只有顶层导航算意图）和 `xhr-fetch`。`Sec-Fetch-User: ?1` 可作为额外的置信度加分，但**不能替代内容判断**，因为打开一个 HTML 页面同样带 `?1`。
- 我们目前**完全没读** `Sec-Fetch-*`：`onBeforeSendHeaders` 之后 `headersToObject()` 只保留 `x-*` 与 `Authorization`（[src/background.js:983-995](src/background.js#L983-L995)）。列为差距 G3。

---

## 5. Chrome / MV3 侧的硬约束

- **观察式 `webRequest` 在 MV3 仍可用**，`webRequestBlocking` 对普通扩展不可用。⇒ 「判定后交给外部程序重取」是唯一合规形态；不要动 `onHeadersReceived` 的返回值（本项目从不返回 `redirectUrl`/`cancel`，取消只走 `chrome.downloads.cancel`）。
- **监听器必须在 Service Worker 顶层同步注册**，异步/延迟 `import` 之后注册的监听会丢事件（Chromium 已知问题）。我们的三个监听都在模块顶层（[src/background.js:692-755](src/background.js#L692-L755）。
- `details` 可用字段：`requestId`（跨重定向与鉴权挑战稳定）、`url`、`method`、`type`、`statusCode`、`responseHeaders`、`documentUrl`、`initiator`、`tabId`、`frameId`、`fromCache`、`redirectUrl`。**没有 `download` 这个 type**；`fetch` 与 XHR 都是 `xmlhttprequest`；`<a download>` 在新框架里常报 `other`。
- `details.type` 是 `ResourceType` 枚举；`'responseHeaders'` 是 Firefox 的 `extraInfoSpec` 写法，不是 Chrome 的事件类型——别把它当判定依据。
- `(fromCache)` 的响应**可能没有任何头** ⇒ 依赖响应头的规则在缓存命中时会漏；这类漏抓属于设计容忍范围。
- `chrome.downloads.onCreated` 对**每一个**下载触发，包括我们自己刚交出去的那些 ⇒ 必须按 URL + 时间窗去重（`recentSent` 12s、`pendingCancel` 15s、`inflightCaptures`，见 [src/background.js:1064-1160](src/background.js#L1064-L1160）。`DownloadItem` 提供 `url`/`finalUrl`/`filename`/`mime`/`referrer`/`totalBytes`/`state`/`danger`，**不提供请求头**。
- 危险文件（`.exe`/`.msi`/部分 `.zip`）会进 Chrome 的 `dangerType`（`uncommon`、`fileTypeWithWarnings`、`potentiallyUnwanted`、`ssl`、`host`、`content`）流程，需要用户「保留」；扩展无法静默代替，企业 `DownloadRestrictions` 策略下也无法绕过。⇒ 交给 NDM 时这条保护由 NDM 自己承担，属于产品定位选择。
- 同源连续自动下载会被限流（Chromium `download_request_limiter.cc`：无手势约 5 个后弹出站点权限） ⇒ 面板式「一次点一条」比「批量自动接管」更安全。
- 复刻鉴权下载需要 `chrome.cookies.getAll({url})`（含 HttpOnly，需 `cookies` 权限）+ 原始 `Referer`/`Origin`/UA；**请求体读不到**，禁止头也无法从 `fetch` 重设。我们把 cookie 与 Referer/Origin 打包给 NDM（[src/background.js:395-431](src/background.js#L395-L431），是这条路能走通的原因。

---

## 6. 看着像下载、但不是下载的东西

| 东西 | 识别特征 | 我们拦住它的规则 |
| --- | --- | --- |
| HLS 主清单 | `#EXTM3U` 开头，`#EXT-X-STREAM-INF`，MIME `application/vnd.apple.mpegurl` | **反向**：清单是我们要的（`hls-playlist`），分片不是 |
| HLS/DASH 分片 | `.m4s`/`.cmfv`/`.ts`/`seg-1`、CDN 常谎报 `video/mp4` 或 `octet-stream` | `stream-segment`（[src/lib/rules.js:165-168](src/lib/rules.js#L165-L168、[:172-175](src/lib/rules.js#L172-L175）、`segment-url`（[:176](src/lib/rules.js#L176） |
| 播放器元数据探测 | `Range: bytes=0-1` 之类 → 206，体积极小 | `partial-media`（[:177](src/lib/rules.js#L177）+ `media-too-small`（[:179-181](src/lib/rules.js#L179-L181） |
| MSE 播放 | `src` 是 `blob:` | 天然不进 `webRequest`（`not-http`） |
| 页面预览图/雪碧图 | `videoshot*`、`videopreview` 路径 | `preview-asset`（[:129](src/lib/rules.js#L129） |
| 站点内部 API 谎报 attachment | Office Online 的 `AppPrefetchResources.ashx` 等对 XHR 回 `attachment` | `internal-api`（[:149](src/lib/rules.js#L149） |
| 图片/字体/脚本/JSON | `image/*`、`NON_DOWNLOAD_MIMES`、`EXPLICIT_ONLY_EXTENSIONS` | `image-asset` / `browser-asset` / `explicit-only`（[:160-162](src/lib/rules.js#L160-L162） |

---

## 7. 同类下载器怎么接浏览器（对照）

| 产品 | 交接通道 | 头/Cookie 来源 | 与我们的差异 |
| --- | --- | --- | --- |
| NDM 官方扩展 | 本机 WebSocket（我们沿用同一协议，`ws://127.0.0.1:10007/download`，子协议 `neatextension.v1`） | 扩展侧取 | 我们改写了判定，媒体只进面板 |
| IDM | 扩展 + 本地 helper（含 IE BHO 时代遗留），拦截激进、会取消并重放浏览器下载 | 全量拦截 | 我们不改写请求、只在判定成立后取消副本 |
| XDM | `downloads` API 拦截 + **native messaging** | 少解析头 | 我们以 `webRequest` 为主、`downloads` 为兜底 |
| JDownloader | `contextMenus`（显式意图）+ `webRequest` Click'N'Load | 走账号 API | 我们也有右键，但主要靠自动判定 |
| aria2 / Motrix / Gopeed | JSON-RPC `aria2.addUri` + 头数组 + `chrome.cookies` 转发 | 显式头列表 | 与我们 `createPayload()` 思路一致 |

共同点：**转发显式头列表 + 用用户意图门控**，而不是纯靠响应嗅探。这佐证了本项目「宁可漏拦」的取舍方向。

---

## 8. 差距清单（本文核对出来的条目与当前状态）

> 编号与 ROADMAP.md 一致。「已闭环」指代码 + 单元测试 + 夹具三者都覆盖，不是只写了代码。

| 编号 | 标准/模式 | 状态 | 现在的处理 |
| --- | --- | --- | --- |
| G1 | `Content-Encoding: gzip/br` | **已闭环** | `snapshot` 读 `content-encoding`（[src/background.js:732](src/background.js#L732)）→ `decideCapture()` 里压缩响应的 `size` 强制为 0（[src/lib/rules.js:95-97](src/lib/rules.js#L95-L97)、[:218-226](src/lib/rules.js#L218-L226)），协议上就不发 `7:`；HEAD 探测同样丢弃压缩长度（[src/background.js:584-588](src/background.js#L584-L588)）。不自己解压、不透传编码。夹具 12 双向断言。 |
| G2 | `Accept-Ranges` | **已闭环（删除）** | 死字段，已从 `snapshot` 移除；判定不依赖「服务器说可以分段」。 |
| G3 | `Sec-Fetch-User` / `Sec-Fetch-Dest` | 未使用 | 无风险；请求头由浏览器保护，扩展读不到，只可作为将来面板提示的加分信号，不可单独放行。 |
| G4 | 跨源 `<a download>` | **已闭环** | 内容脚本比较 origin 后才认这个属性（`data:`/`blob:` 例外，[src/content/catcher.js:134-149](src/content/catcher.js#L134-L149)）。 |
| G5 | 真实文件名只在 DOM | 未做（协议限制） | `filename` 算出来了但**不在 NDM 协议上**（[src/lib/ndm.js:21-82](src/lib/ndm.js#L21-L82) 无文件名字段）。属于协议限制，先确认 NDM 是否支持额外字段再动。 |
| G6 | 重定向链 + 签名 URL | **部分闭环** | 夹具 14 断言 302→zip 只发一条；`waitingFetches` 的 HEAD 探测遇到非 2xx 记 `head-status-<code>` 而不是报错（[src/background.js:567-581](src/background.js#L567-L581)）。**仍未做**：主路径不聚合 `redirectUrl`，跨 host 重定向后 Referer/Cookie 作用域仍按原始 URL 打包。 |
| G7 | 203 Non-Authoritative | 保留（有意的宽松） | 在状态码白名单里（[src/lib/rules.js:79-81](src/lib/rules.js#L79-L81)）；代理改写过的 CD/长度可能非源站值，知道即可。 |
| G8 | `multipart/byteranges` | 未做 | 多范围 206 会被当单文件；现在 206 只在 attachment 下放行，风险低。 |
| G9 | 兜底伪造 `statusCode: 200` | 保留（已知取舍） | 兜底路径写死 200（[src/background.js:1168-1175](src/background.js#L1168-L1175)）；浏览器已确认这是下载，绕过的只是 `partial-response` 检查。写在 DEVELOPMENT.md。 |
| G10 | POST 体重放 | **已闭环** | 上限 96KB（`MAX_POST_BODY_BYTES`，[src/lib/utils.js:184](src/lib/utils.js#L184)）：原始字节超限（[:198-200](src/lib/utils.js#L198-L200)）与表单体重放超限（`limitBody`，[:249-254](src/lib/utils.js#L249-L254)）都只回 `truncated`，绝不发半截；`decideCapture()` 见 `postBodyTooLarge` 直接 `deny('post-body-too-large')`（[src/lib/rules.js:76-78](src/lib/rules.js#L76-L78)）。夹具 13 断言这条 URL **一条都不能发**——去掉规则时夹具会红，说明断言有效。 |
| G11 | `tabId` 字段 | **已闭环（改文档）** | DEVELOPMENT.md 的 `decideCapture()` 签名已删掉 `tabId`；「`tabId < 0` 不发送」确实是兜底路径自己的判断，与规则无关。 |
| G12 | 兜底路径假设 GET | **已闭环** | 下载条目没有请求方法与请求体，兜底路径只能按 GET 转发。因此凡是「只有带请求体才成立」的下载被拒绝时必须记住 URL（`BROWSER_ONLY_REASONS`，[src/lib/constants.js:260-265](src/lib/constants.js#L260-L265)、[src/background.js:912-921](src/background.js#L912-L921)），否则兜底会把一个 POST 下载当 GET 重取。夹具 13 正是这条的回归。 |

---

## 9. 场景 ↔ 夹具覆盖矩阵

`node scripts/web-test.mjs --fixtures` 的 14 个场景（[scripts/fixtures.mjs:317-390](scripts/fixtures.mjs#L317-L390)）与上文模式的对应：

| 夹具场景 | 覆盖的第 3 节模式 | 期望 |
| --- | --- | --- |
| 1 zip 直链导航 | #1 | 捕获 1 条 `6:normal` |
| 2 POST 表单下载 | #5 | 捕获且带 `1:POST` + `__0NeatPostData9__` |
| 3 直接导航到 zip | #1 | 捕获 |
| 4 `octet-stream` 无扩展名导航 | §2.3 | 捕获（`forced-download`） |
| 5 `Content-Disposition` 附件（无扩展名 URL） | §2.1 | 捕获 |
| 6 HTML 以附件返回 | §2.1 | 捕获（`html-page` 被 attachment 覆盖） |
| 7 视频页加载 + `<video>` 元数据/206 | §6 | **0 条**，且 `/video.html`、`/media.mp4` 不得出现 |
| 8 XHR 取回图片 | #6 变体 | 0 条 |
| 9 RFC 2047 文件名 | §2.2 | 0 条（留给浏览器） |
| 10 `.m3u8` 清单 | §6 | 捕获为 `6:hls` |
| 11 `blob:` 下载 | #10 | 0 条 |
| 12 gzip 附件 | §2.4 | 捕获，但消息里**不得出现 `7:` 行**（`notMatch` 按整行前缀判定） |
| 13 请求体超过 96KB 的 POST | §2.4、G10/G12 | **0 条**（既不能发半截体，也不能被兜底路径当 GET 重取） |
| 14 302 跳转到 zip | §5、G6 | 恰好 1 条，且 `/redirect-c14.zip` 不得出现 |

**尚未被夹具覆盖**（想验证时先补场景再改规则）：跨源 `<a download>`（#3）、ReadableStream 多分片并行（#7）、StreamSaver / File System Access（#8/#9）、签名参数在几十秒后过期的 CDN（#11）、`multipart/byteranges`、416。

---

## 参考资料

**标准**
- RFC 9110 HTTP Semantics：https://www.rfc-editor.org/rfc/rfc9110.html （§8.3/8.4/8.6、§13.1.5、§14.2/14.3/14.4/14.6、§15.3.1/15.3.4/15.3.7/15.5.17）
- RFC 7233 Range Requests（已被 9110 取代）：https://www.rfc-editor.org/rfc/rfc7233
- RFC 6266 Content-Disposition over HTTP：https://www.rfc-editor.org/rfc/rfc6266
- RFC 8187（取代 RFC 5987）HTTP Header Field Parameter Value Continuation：https://www.rfc-editor.org/rfc/rfc8187
- RFC 2047 MIME Extended Numeric Encoding（邮件头专用）：https://www.rfc-editor.org/info/rfc2047/
- RFC 8216 HLS：https://www.rfc-editor.org/info/rfc8216/ （后继草案 draft-pantos-hls-rfc8216bis）
- WHATWG HTML（`download` 属性）：https://html.spec.whatwg.org/multipage/links.html
- Fetch Metadata Request Headers（W3C）：https://w3c.github.io/webappsec-fetch-metadata/
- MIME Sniffing Standard：https://mimesniff.spec.whatwg.org/
- W3C Media Source Extensions：https://w3c.github.io/media-source/
- IANA Media Types 注册表：https://www.iana.org/assignments/media-types/

**MDN**
- Content-Disposition：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition
- `<a>` / download：https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a
- Content-Length / Content-Encoding / Range：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Length · …/Content-Encoding · …/Range
- Sec-Fetch-Dest / Sec-Fetch-User：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Dest · …/Sec-Fetch-User
- X-Content-Type-Options：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Content-Type-Options

**Chrome / Chromium**
- webRequest：https://developer.chrome.com/docs/extensions/reference/api/webRequest
- downloads：https://developer.chrome.com/docs/extensions/reference/api/downloads
- Service Worker 事件监听：https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events
- 多下载限流源码：https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/download/download_request_limiter.cc
- DownloadRestrictions 策略：https://chromeenterprise.google/policies/download-restrictions/
- 文件名解码的 Chromium 讨论：https://issues.chromium.org/40324274 · Firefox 侧 RFC 2047：https://bugzilla.mozilla.org/show_bug.cgi?id=601933
- Content-Disposition 实测矩阵：https://greenbytes.de/tech/tc2231/

**同类实现**
- NDM 官网：https://www.neatdownloadmanager.com/index.php/en/about
- XDM 集成模块：https://github.com/subhra74/xdm-integration-module
- MyJDownloader（MV3）：https://github.com/magnetgrouplabs/myjdownloader-extension-mv3
- Aria2-Explorer：https://github.com/alexhua/Aria2-Explorer
- StreamSaver.js：https://github.com/jimmywarting/StreamSaver.js
- S3 `binary/octet-stream` 由来：https://s3tools.org/usage

---

<a id="english-summary"></a>
## English summary

This document is the reference manual behind `decideCapture()`: what the standards actually say about web file downloads, and how those rules map onto this codebase.

Key points a maintainer must not get wrong:

- `Content-Disposition` is **not** part of HTTP (RFC 9110 never mentions it); it is defined by RFC 6266, and the UA still decides the real behaviour.
- Filenames come in three flavours: `filename=` (ASCII, percent-decoding differs per browser — Safari does not decode), `filename*=UTF-8''…` (RFC 8187, the only reliable one) and RFC 2047 encoded words, which are **invalid in HTTP** and which neither Chrome nor NDM decodes — hence the `rfc2047-filename` rejection.
- `<a download>` is honoured **only for same-origin** URLs (plus same-origin `blob:`/`data:`); the attribute's filename never appears on the wire, and `Content-Disposition`'s `filename` overrides it.
- The dominant modern pattern (`fetch → Blob → createObjectURL → <a download>`) looks like a plain XHR at the network layer; the real filename exists only in the DOM and `blob:` URLs never reach `webRequest`. Refusing XHR attachments is therefore correct, not a gap.
- `Content-Length` is absent under `chunked` and means the **compressed** size under `Content-Encoding: gzip/br`; Range offsets address encoded bytes. Encoded responses must therefore report no size; we do that in rules.js (gap G1 is closed).
- A server may legally answer a `Range` request with **200**; 206 must carry `Content-Range`, 416 must carry `bytes */total`, and only `If-Range` + `ETag`/`Last-Modified` makes resume safe.
- `application/force-download`, `application/download`, `application/binary` and S3's `binary/octet-stream` are **not registered** MIME types — our `FORCED_DOWNLOAD_MIMES` is an empirical table, not a standard.
- Fetch Metadata (`Sec-Fetch-Dest/Mode/User`) has **no `download` destination**, so user intent can only be inferred; our `type === 'main_frame'` requirement is the standard-equivalent approximation.
- MV3 keeps **observational** `webRequest` (no `webRequestBlocking`), which is precisely why an "extension decides, manager re-fetches" architecture is legitimate. There is no `download` resourceType, `requestId` survives redirects, and `(fromCache)` responses may carry no headers at all.

Section 8 lists the standards we do **not** handle yet (G1–G11) and section 9 maps all 11 fixture scenarios to the patterns above.
