# OpenNDM-Extension 隐私政策 / Privacy Policy

最后更新：2026-10-22 ｜ Last updated: 2026-10-22

> 发布前请把 `[[CONTACT_EMAIL]]` 替换为你的联系邮箱，并确认与商店后台填写的一致。

## 中文

### 一句话说明

OpenNDM-Extension 不收集、不上传、不出售任何用户数据。它只把下载任务交给**运行在你自己电脑上**的 Neat Download Manager（下称 NDM），所有处理都在本机完成。

### 扩展会接触哪些信息

仅在为你完成一次下载或显示页面媒体面板时，扩展会在内存中短时处理：

- **当前页面地址与标题**：用于构造下载请求的 Referer、Page URL、Page Title，以及判断当前站点是否被屏蔽。
- **请求与响应元数据**：响应的 Content-Type、Content-Disposition、Content-Length、Content-Range，请求的 `x-*` 鉴权头；用于判断一个响应是不是真正的下载。
- **该下载地址对应的 Cookie**：由浏览器读取后随下载任务一起交给本机 NDM，使其能复现你已登录的请求。
- **POST 下载的表单内容**：仅当下载本身是表单提交时，本地捕获后交给 NDM 重放同一请求。

### 数据去哪里

- 上述信息只通过本机回环地址 `ws://127.0.0.1:10007` 发送给用户自行安装的 NDM。
- 扩展**没有**任何自有服务器，不包含统计、埋点、广告或崩溃上报，不会把数据发送到互联网上的任何地址。
- 扩展不读取、不上传下载文件的内容；页面侧只检查 `<video>`/`<audio>` 等媒体元素及其标题，用于在本地渲染媒体面板，不读取页面正文与表单内容。

### 保存了什么

- `chrome.storage.local`：你的设置（是否捕获、是否捕获媒体、媒体面板、端口、媒体最小体积）与站点屏蔽列表。
- `chrome.storage.session` / 内存：短时状态，例如 Ctrl 绕过计时、弹窗里的最近捕获列表。
- 以上数据都留在本机，不参与 Chrome 同步；卸载扩展即被删除。

### 权限用途

- `webRequest`：读取响应头判断是否为下载。
- `cookies`：读取该下载地址的 Cookie，交给本机 NDM 复现已登录的请求。
- `downloads`：取消交给 NDM 之后浏览器产生的重复下载。
- `tabs` / `webNavigation`：确定请求所属页面，并在页面切换时重置状态。
- `storage`：保存设置与站点屏蔽列表。
- `contextMenus`：右键「使用 NDM 下载」与「在当前站点屏蔽」。
- `alarms`：保持与本机 NDM 的连接。
- `<all_urls>`：下载可能来自任意网站，需要在该主机上观察响应头并读取 Cookie。

### 你的控制权

- 可在弹窗或设置页关闭捕获、关闭媒体面板。
- 可在弹窗中对当前站点一键屏蔽。
- 点击下载时按住 Ctrl（macOS 为 ⌘）可让本次下载留在浏览器。
- 卸载扩展会清除全部本地设置。

### 第三方

NDM 是独立软件，由 Neat Download Manager 的作者开发与分发，本扩展与其无隶属关系。NDM 自身如何处理你交给它的下载任务，适用其自己的隐私政策：<https://www.neatdownloadmanager.com/>。

### 儿童

本扩展不是面向儿童的产品，也不会有意处理儿童的个人信息。

### 变更与联系

若本政策发生变更，会更新本页顶部的日期。任何疑问请联系：`[[CONTACT_EMAIL]]`。

## English

### In one sentence

OpenNDM-Extension collects nothing, uploads nothing, and sells nothing. It only hands downloads to Neat Download Manager (NDM), an application running on your own computer, so all processing stays on your device.

### What the extension touches

Only while completing a download or rendering the page media panel, and only in memory:

- **Current page URL and title** — to build the Referer, Page URL and Page Title of a download, and to check whether the current site is blocked.
- **Request and response metadata** — response Content-Type, Content-Disposition, Content-Length, Content-Range, and `x-*` request auth headers, used to decide whether a response is a real download.
- **Cookies for that download URL** — read by the browser and passed with the download so NDM can reproduce your authenticated request.
- **POST form data** — only when the download itself is a form submission; captured locally so NDM can replay the same request.

### Where it goes

- Only to `ws://127.0.0.1:10007`, the loopback address of the NDM app you installed.
- The extension has **no** backend: no analytics, no telemetry, no ads, no crash reporting, and no internet endpoint of any kind.
- It never reads or uploads downloaded file contents. On the page it only inspects media elements (`<video>`/`<audio>`) and their titles to render the local panel, never page body text or form fields.

### What is stored

- `chrome.storage.local`: your settings (capture, media capture, media panel, port, minimum media size) and the per-site block list.
- `chrome.storage.session` / memory: short-lived state such as the Ctrl-bypass timer and the recent-captures list in the popup.
- All of it stays on this device, is not synced by Chrome, and is removed when the extension is uninstalled.

### Why each permission

- `webRequest` — read response headers to recognise downloads.
- `cookies` — read cookies for the download URL so the local NDM can repeat your authenticated request.
- `downloads` — cancel the duplicate browser download after NDM takes over.
- `tabs` / `webNavigation` — identify the page a request belongs to and reset state on navigation.
- `storage` — keep settings and the site block list.
- `contextMenus` — the "Download with NDM" and "Block NDM on this site" right-click items.
- `alarms` — keep the local NDM connection alive.
- `<all_urls>` — downloads can start on any site, so response headers and cookies must be readable there.

### Your controls

- Turn capture or the media panel off in the popup or settings page.
- Block a site with one click in the popup.
- Hold Ctrl (⌘ on macOS) while clicking a download to keep it in the browser.
- Uninstalling removes all local settings.

### Third parties

NDM is a separate application developed and distributed by the Neat Download Manager author; this extension is not affiliated with it. NDM's own handling of the downloads you send it is covered by its privacy policy: <https://www.neatdownloadmanager.com/>.

### Children

This extension is not directed to children and does not knowingly process children's personal information.

### Changes and contact

If this policy changes, the date at the top of this page is updated. Questions: `[[CONTACT_EMAIL]]`.
