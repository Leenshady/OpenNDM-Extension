# Chrome Web Store 权限说明与隐私材料

> 用途：Chrome 开发者后台「Privacy practices → Permission justification」逐项粘贴。
> 每项都控制在 1000 字符以内（已用脚本统计，见文末）。
> 下面英文段落都用代码块包住，方便原样复制；`<all_urls>` 不会被 Markdown 当成标签吞掉。

## 提交前先看

**单一用途（Single purpose）**

> Hands downloads from the browser to the Neat Download Manager desktop app running on the same computer, and optionally lists the media found on the current page. No other purpose, no remote service.

**是否可以精简 `tabs` 权限**

`tabs` 只用于读取 `tab.url` / `tab.title`，而 `host_permissions: ["<all_urls>"]` 已授予 http(s) 标签页这两个字段的访问权；`chrome.tabs.query/get/sendMessage` 以及 `onActivated/onUpdated/onRemoved` 都不需要 `tabs` 权限。因此 **`tabs` 很可能是多余的**，商店明确写着「申请用不到的权限会被拒」。

建议：先删掉 `manifest.json` 里的 `"tabs"`，重新加载扩展，确认弹窗、站点屏蔽开关、媒体面板都正常；若一切正常就按下面的方案提交（`tabs` 那一栏不会出现）。若发现异常再把它加回来，并使用下方 `tabs` 的说明。

**远程代码**：没有。没有 `eval`、没有远程脚本、`web_accessible_resources` 里也没有可执行脚本，声明为 No。

**数据收集**：商店把「收集」定义为把数据传出设备。本扩展只发往 `127.0.0.1`（用户自己安装的 NDM），因此勾选「不收集用户数据」；但由于会接触 Cookie 与浏览地址，仍应提供隐私政策链接（见 `privacy-policy.md`）。

---

## English (paste into the dashboard)

### alarms

```text
Keepalive for the local download-manager connection. Chrome suspends MV3 service workers when idle, which would drop the WebSocket to the Neat Download Manager app running on 127.0.0.1:10007. A one-minute alarm wakes the worker only to reconnect that local socket and refresh the toolbar badge, so a download the user starts is captured immediately. The alarm carries no user data and is created only on install/startup.
```

### contextMenus

```text
Two user-triggered items: "Download with NDM" on a link, image, video, or the page itself (sends that single URL to the local Neat Download Manager), and "Block NDM on this site" (adds the current host to a local blocklist so this extension never touches downloads there). Both act only on the element the user right-clicked; nothing is recorded about browsing.
```

### cookies

```text
Read-only and per-download. When a response is recognised as a download, the extension reads the cookies that apply to that exact URL (chrome.cookies.getAll) and passes them, together with the URL, to the Neat Download Manager app on 127.0.0.1 so the app can reproduce the same authenticated request. Cookies are never stored by this extension, never logged, and never sent to a remote server; the only recipient is the local app the user installed.
```

### downloads

```text
Duplicate prevention only. After a download has been handed to NDM, Chrome may start its own copy; the extension cancels and erases that duplicate so the user does not end up with two files. When NDM is not running, the browser copy is left untouched. The extension never reads, scans, or uploads the contents of downloaded files.
```

### storage

```text
Stores the user's own preferences (capture on/off, media capture, page media panel, NDM port, minimum media size), the per-site block list, and a small page-level bypass flag. chrome.storage.session keeps short-lived state only (bypass timer and the recent-captures list shown in the popup). Everything stays on this device; nothing is synced or transmitted.
```

### tabs

```text
Identifies the page a request belongs to: reads the active tab's URL and title to provide the Referer, Page URL, and Page Title that NDM needs for authenticated downloads, and to deliver per-tab messages (state updates, media panel, notices) to the content script. No browsing history is built; URLs are used in memory for the current download only.
```

### webNavigation

```text
Uses top-frame navigations and single-page-app history changes (pushState) to reset per-tab state: media listed for the previous page is cleared, and the page URL/title used as download context is refreshed. Only the navigation URL and its timestamp are read; nothing is stored or transmitted.
```

### webRequest

```text
Core of the extension. Observes http(s) response headers only (Content-Type, Content-Disposition, Content-Length, Content-Range) to decide whether a response is a real download rather than a page or asset. It never blocks, redirects, or modifies traffic. Request headers are read only to replay x-* auth headers; for POST downloads the form body is captured locally so NDM can repeat the same request. Captured metadata is sent only to the local NDM app.
```

### Host permission

```text
<all_urls> is required because a download can be started on any website: the extension must observe that host's response headers to recognise the download, and read that host's cookies so the local download manager can fetch the same URL. A narrower pattern list is impossible because the extension cannot know in advance which sites the user downloads from. The content script also runs on any http(s) page to offer the media panel. No page content is uploaded; the only destination is 127.0.0.1 (the user's own NDM).
```

---

## 中文对照（供你核对，不必提交）

### alarms

保持与本地下载器的连接。Chrome 空闲时会挂起 MV3 Service Worker，导致与 `127.0.0.1:10007` 上运行的 Neat Download Manager 之间的 WebSocket 断开。每分钟一次的闹钟只用于重连这个本地连接并刷新工具栏角标，保证用户发起的下载能被立即捕获。闹钟不携带任何用户数据，仅在安装/启动时创建。

### contextMenus

两个由用户主动触发的菜单项：「使用 NDM 下载」（作用于链接、图片、视频或整页，把该 URL 交给本地 Neat Download Manager）和「在当前站点屏蔽 NDM」（把当前域名写入本地屏蔽列表，此站点下载不再被接管）。只处理用户右键选中的元素，不记录浏览行为。

### cookies

只读、只在单次下载时读取。当响应被判定为下载时，扩展读取**该 URL 对应**的 Cookie（`chrome.cookies.getAll`），连同 URL 一起交给 `127.0.0.1` 上的 NDM，使其能复现同样的已登录请求。Cookie 不会被扩展存储、不会写日志、不会发送到任何远程服务器；接收方只有用户自己安装的本地程序。

### downloads

仅用于去重。下载交给 NDM 后，Chrome 可能同时开始自己的下载副本，扩展取消并删除该重复副本，避免用户拿到两份文件。NDM 未运行时不会动浏览器副本。扩展从不读取、扫描或上传已下载文件的内容。

### storage

保存用户自己的设置（是否捕获、是否捕获媒体、页面媒体面板、NDM 端口、媒体最小体积）、站点屏蔽列表，以及一个页面级的 Ctrl 绕过标记。`chrome.storage.session` 只保存短时状态（绕过计时、弹窗里的最近捕获）。全部保存在本机，不做同步、不外传。

### tabs

用于确定请求属于哪个页面：读取活动标签页的 URL 与标题，提供给 NDM 作为 Referer、Page URL、Page Title，并用于向该标签页的内容脚本发送状态更新、媒体面板与提示消息。不建立浏览历史；URL 只在当前下载的内存上下文中使用。

### webNavigation

通过顶层导航与单页应用的路由切换（pushState）重置标签页状态：清除上一页的媒体列表，并刷新作为下载上下文的页面 URL/标题。只读取导航 URL 与时间戳，不存储、不外传。

### webRequest

扩展的核心。只观察 http(s) 的**响应头**（Content-Type、Content-Disposition、Content-Length、Content-Range），判断响应是真正的下载还是页面/静态资源；从不拦截、重定向或修改请求。请求头仅用于转发 `x-*` 鉴权头；POST 下载时表单内容会被本地捕获，以便 NDM 重放同一请求。捕获到的元数据只发给本地 NDM。

### Host permission

必须使用 `<all_urls>`，因为下载可能来自任意网站：扩展需要观察该主机的响应头来判断是否为下载，并读取该主机的 Cookie，让本地下载器能请求同一个 URL；无法预先给出更窄的域名列表。内容脚本也需要在任意 http(s) 页面运行以提供媒体面板。页面内容不会被上传；唯一目标是 `127.0.0.1`（用户自己的 NDM）。
