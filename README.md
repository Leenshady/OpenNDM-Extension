# 开源NDM扩展

<a id="chinese"></a>
**[English ↓](#english)** · [GPL-3.0-or-later](LICENSE)

一个全新重写的 **Manifest V3** Neat Download Manager 浏览器扩展：只把真正的下载交给本机 NDM，并尽量不影响日常浏览。

## 功能

- **下载捕获**：直链下载、`Content-Disposition` 附件，以及 JavaScript 调起的浏览器下载。
- **按住 Ctrl 跳过**：按住 **Ctrl**（macOS 为 **⌘ Command**）点击链接，本次下载交给浏览器，并显示简短提示。
- **屏蔽站点**：在弹窗或页面右键菜单屏蔽当前站点，该主机及其子域名的下载全部绕过 NDM。
- **页面媒体面板**：页面中的视频、音频集中到右下角浮层，点击条目即可发送到 NDM；默认最小化，不遮挡页面。
- **不打扰浏览**：页面自己的 `fetch`/XHR、配置包、流媒体分片、广告与弹幕资源不会被自动下载；拿不准的下载留在浏览器。
- **兼容 NDM 协议**：`ws://127.0.0.1:10007/download`，`neatextension.v1` 子协议。
- **Chrome 原生风格**：明暗主题、系统字体、原生开关，弹窗与设置页保持紧凑。
- **中英双语**：界面跟随浏览器显示语言，遇到不支持的语言回退英文。
- **无统计、无远程服务器**：请求元数据只发送给本机 `127.0.0.1` 的 NDM。

## 环境要求

- 支持 Manifest V3 的 Chrome、Edge 或其他 Chromium 浏览器（建议 116 及以上）。
- 已安装并运行 [Neat Download Manager](https://www.neatdownloadmanager.com/)。
- NDM 默认本地 WebSocket 端口为 `10007`。如果你在 NDM 中改过端口，请在本扩展中填写相同端口。

## 安装

### 从 Edge 扩展商店安装（推荐）

[开源NDM扩展 · Microsoft Edge 加载项](https://microsoftedge.microsoft.com/addons/detail/iikaogclapbbpffhjjhdnnbeenfidllj)

在 Edge 中打开链接，点击 **获取** 即可安装。首次使用请启动 NDM，并在弹窗中确认连接状态。

### 开发者模式（Chrome / Chromium / Edge）

1. 下载或克隆本项目，并放在固定位置。
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）。
3. 打开右上角的 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择包含 `manifest.json` 的文件夹。
5. 将 **开源NDM扩展** 固定到工具栏。
6. 启动 NDM，打开弹窗；如果显示未连接，点击 **测试**。

## 使用说明

### 捕获下载

打开网页并点击普通下载链接。如果响应是支持的文件类型，扩展会把它发送给 NDM，并默认取消浏览器中重复的下载；NDM 未运行时不会接管，下载会留在浏览器中。

JavaScript 通过 `chrome.downloads.onCreated` 触发的下载也会被接管。如果页面先用 `fetch`/XHR 取回文件再转成 `blob:` 保存（后台系统的导出、附件按钮常见），真实文件名只存在于页面里，这类下载会留给浏览器完成，避免出现「NDM 存成哈希名、浏览器又下一份」的重复。

有些服务器把文件名按 **RFC 2047** 编码（`Content-Disposition: attachment; filename="=?UTF-8?B?...?="`，网易邮箱等较常见）。NDM 无法解码这种名字，扩展会把这类下载整个交给浏览器，由浏览器还原原始文件名。

### 跳过单次下载

点击链接时按住 **Ctrl**（或在聚焦链接上按住 Ctrl 按 Enter）。扩展会设置一个短暂的绕过窗口，本次下载由浏览器正常处理。

### 屏蔽站点

- 打开弹窗，关闭 **当前站点** 开关；或
- 在页面右键选择 **屏蔽此站点的下载**。

此后该主机及其子域名的所有下载都使用浏览器。可在相同位置取消屏蔽，也可在 **设置 → 屏蔽站点** 中编辑列表。

### 页面媒体

页面包含可直接下载的视频或音频时，右下角默认显示一个最小化的胶囊按钮；点击它展开面板，点击标题栏的最小化按钮（⌄）再次收起。弹窗中的「展开媒体面板」开关与该状态互锁：最小化后显示为关闭，打开即展开当前页面。也可在 **设置 → 捕获 → 页面媒体面板** 中彻底关闭该功能。

面板刻意保持保守：DRM/加密流、`blob:`、`data:` 以及仅通过 MSE 播放的流无法交给 NDM，因此不会列出。

## 支持的文件类型

与参考版 NDM 插件保持一致，按用途分组：

| 分组 | 示例 |
| --- | --- |
| 视频 / 音频 | MP4、M4V、MKV、WEBM、MOV、AVI、WMV、FLV、TS、M3U8、MP3、M4A、AAC、FLAC、WAV、OGG、OPUS |
| 压缩包 / 安装包 | ZIP、RAR、7Z、TAR、GZ、BZ2、XZ、ISO、DMG、PKG、MSI、EXE、APK、JAR |
| 文档 / 电子书 | PDF、DOC、DOCX、XLS、XLSX、PPT、PPTX、EPUB、MOBI、MSG、CSV、RTF |
| 字幕 | SRT、VTT、ASS、SSA、DFXP、TTML |
| 仅附件响应头 | HTML、CSS、JS、JSON、XML、TXT、PNG、JPG、GIF、SVG、WEBP、WOFF2、WASM、BIN |

最后一组只有服务器返回 `Content-Disposition: attachment`，或你主动从右键菜单选择 **使用 NDM 下载** 时才会捕获。

## 隐私

- 无统计、无追踪、无账号、无远程接口。
- Cookie、Referer 与请求元数据只发送给本机 `127.0.0.1` 的 NDM。
- 捕获的 URL 仅保存在内存/会话存储中用于「最近捕获」，点击 **清除** 或重启浏览器后清空。
- 扩展只读取响应元数据；除可选的媒体面板/提示外，不修改页面内容。

## 已知限制

- DRM 保护或加密媒体无法由 NDM 下载。
- `blob:` 和 `data:` URL 只能由浏览器处理，会被跳过。
- B 站 DASH 播放可能分别暴露视频轨和音频轨；NDM 会将它们作为独立文件下载，不会自动合并。
- 带防盗链、一次性令牌或通过 WebSocket 传输媒体的网站，可能需要手动重试或改用浏览器下载。
- NDM 必须处于运行状态。如果端口被占用，请在 NDM 和本扩展中同时修改端口。

## 许可证

本项目使用 **GNU General Public License v3.0 or later**（`GPL-3.0-or-later`）。详见 [LICENSE](LICENSE)。

本项目是独立重写版本。Neat Download Manager 是其作者开发的独立软件，本项目与其没有隶属或背书关系。

## 署名

本项目的代码、测试、构建脚本、文档以及中英文注释，均由 AI 编程助手 **DeepSeek Harness（deepseek-flash 模型）** 生成。

- 生成者：DeepSeek Harness · deepseek-flash
- 人类维护者的工作：提出需求、确认行为、验收并发布版本
- 日期：2026-10-22

## 开发

开发环境、模块结构、捕获规则、NDM 协议、打包与测试等细节见 [DEVELOPMENT.md](DEVELOPMENT.md)。

---

<a id="english"></a>
# OpenNDM-Extension

**[中文 ↑](#chinese)** · [GPL-3.0-or-later](LICENSE)

A clean **Manifest V3** rewrite of the Neat Download Manager browser extension. It sends real downloads to the local NDM app and stays out of normal browsing.

## Features

- **Download capture** — direct HTTP(S) downloads, `Content-Disposition` attachments, and JavaScript-triggered browser downloads.
- **Ctrl to skip** — hold **Ctrl** (or **⌘ Command** on macOS) while clicking a link; that download stays in the browser, with a small toast confirming the bypass.
- **Block sites** — block the current site from the popup or the page context menu; every download from that host and its subdomains bypasses NDM.
- **Page media panel** — videos and audio found on the page are collected in a bottom-right panel; click an item to send it to NDM. Minimised by default so it never covers the page.
- **No browsing noise** — page `fetch`/XHR calls, config bundles, streaming segments, ads, and danmaku assets are never downloaded automatically; anything uncertain stays in the browser.
- **NDM protocol compatible** — `ws://127.0.0.1:10007/download` with the `neatextension.v1` subprotocol.
- **Chrome-native UI** — light/dark support, system fonts, native switches, and a compact popup/options page.
- **Bilingual** — the UI follows the browser display language, falling back to English.
- **No analytics, no remote server** — request metadata goes only to the local NDM at `127.0.0.1`.

## Requirements

- Chrome, Edge, or another Chromium-based browser with Manifest V3 support (116+ recommended).
- [Neat Download Manager](https://www.neatdownloadmanager.com/) installed and running.
- NDM's default local WebSocket port is `10007`. If you changed it in NDM, set the same port in this extension.

## Install

### From Edge Add-ons (recommended)

[OpenNDM-Extension · Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/iikaogclapbbpffhjjhdnnbeenfidllj)

Open the link in Edge and click **Get**. Start NDM first, then open the popup and check the connection status.

### Load unpacked (Chrome / Chromium / Edge)

1. Download or clone this folder and keep it in a permanent location.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin **OpenNDM-Extension** to the toolbar.
6. Start NDM, open the popup, and click **Test** if the status is not connected.

## Usage

### Capture a download

Open a page and click a normal download link. If the response is a supported file, the extension sends it to NDM and (by default) cancels the browser's duplicate download. If NDM is not running nothing is taken over and the download stays in the browser.

JavaScript-triggered downloads are handled through `chrome.downloads.onCreated`. When a page fetches a file with `fetch`/XHR and re-wraps it as a `blob:` download (common for export and attachment buttons in admin panels), the real filename exists only in the page; those downloads are left to the browser so you do not end up with a hash-named NDM copy plus a second browser file.

Some servers encode the filename as an **RFC 2047** word (`Content-Disposition: attachment; filename="=?UTF-8?B?...?="`, common with NetEase and other webmail). NDM cannot decode it, so the extension hands those downloads to the browser, which restores the original filename.

### Skip one download

Hold **Ctrl** while clicking the link (or while pressing Enter on a focused link). The extension marks a short bypass window and the browser handles that download normally.

### Block a site

- Open the popup and switch **Current site** off, **or**
- Right-click the page and choose **Block downloads on this site**.

All downloads from that host and its subdomains then use the browser. Unblock from the same places, or edit the list in **Settings → Blocked sites**.

### Page media

When a page contains direct video or audio, a minimised pill appears at the bottom-right by default; click it to expand the panel, and use the minimise button (⌄) in the header to collapse it again. The popup's **Expand media panel** switch is interlocked with that state — it shows off while minimised and expands the current page when turned on. Use **Settings → Capture → Page media panel** to disable the feature entirely.

The panel is intentionally conservative: encrypted/DRM streams, `blob:` URLs, `data:` URLs, and MSE-only streams cannot be downloaded by NDM and are not listed.

## Supported file types

Compatible with the reference NDM add-on, grouped for clarity:

| Group | Examples |
| --- | --- |
| Video / audio | MP4, M4V, MKV, WEBM, MOV, AVI, WMV, FLV, TS, M3U8, MP3, M4A, AAC, FLAC, WAV, OGG, OPUS |
| Archives / installers | ZIP, RAR, 7Z, TAR, GZ, BZ2, XZ, ISO, DMG, PKG, MSI, EXE, APK, JAR |
| Documents / e-books | PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, EPUB, MOBI, MSG, CSV, RTF |
| Subtitles | SRT, VTT, ASS, SSA, DFXP, TTML |
| Explicit attachment only | HTML, CSS, JS, JSON, XML, TXT, PNG, JPG, GIF, SVG, WEBP, WOFF2, WASM, BIN |

The last group is captured only when the server sends `Content-Disposition: attachment`, or when you explicitly choose **Download with NDM** from the context menu.

## Privacy

- No analytics, tracking, accounts, or remote endpoints.
- Cookies, referer, and request metadata are sent only to the local NDM app at `127.0.0.1`.
- Captured URLs are kept in memory/session storage for the recent list and are cleared when you press **Clear** or restart the browser.
- The extension only reads response metadata and never modifies page content except for the optional media panel/toast.

## Limitations

- DRM-protected or encrypted media cannot be downloaded by NDM.
- `blob:` and `data:` URLs are browser-only and are skipped.
- Bilibili DASH playback may expose separate video and audio tracks; NDM downloads them as separate files and does not merge them.
- Some sites with anti-hotlink logic, one-time tokens, or WebSocket-delivered media may need a manual retry or a browser download.
- NDM must be running for capture. If the port is occupied, change it in both NDM and this extension.

## License

This project is licensed under the **GNU General Public License v3.0 or later** (`GPL-3.0-or-later`). See [LICENSE](LICENSE).

This is an independent rewrite. Neat Download Manager is a separate application by its respective authors; this project is not affiliated with or endorsed by them.

## Attribution

The code, tests, build scripts, documentation, and bilingual comments in this project were generated by the AI coding agent **DeepSeek Harness (deepseek-flash model)**.

- Generated by: DeepSeek Harness · deepseek-flash
- Human maintainer's role: requirements, behaviour review, acceptance, and releases
- Date: 2026-10-22

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the development environment, module layout, capture rules, NDM protocol, packaging, and tests.
