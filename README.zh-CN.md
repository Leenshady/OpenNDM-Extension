# 开源NDM扩展

一个全新重写的 **Manifest V3** Neat Download Manager 浏览器扩展。它只捕获真正的下载和页面媒体，交给本机 NDM，并尽量不影响日常浏览。

[English README](README.md) · [GPL-3.0-or-later](LICENSE)

## 功能

- **下载捕获**：直链下载、`Content-Disposition` 附件、无扩展名下载接口，以及 JavaScript 调起的浏览器下载。
- **按住 Ctrl 跳过**：按住 **Ctrl**（macOS 为 **⌘ Command**）点击链接，本次下载交给浏览器，并显示简短提示。
- **屏蔽站点**：可在弹窗或页面右键菜单屏蔽当前站点。该站点及其子域名的所有下载都会绕过 NDM。
- **页面媒体面板**：使用 Shadow DOM 的现代浮层，收集 `<video>`、`<audio>`、`<source>`、`<embed>`、`<object>`、网络媒体，以及 B 站 `__playinfo__` 中的音视频轨（包括 `<video>` 使用 `blob:` 的 MSE 页面）。点击即可发送到 NDM。
- **精确规则**：只在明确的下载意图下接管——顶层导航、带文件名的 `Content-Disposition` 附件、浏览器下载事件；页面自己的 `fetch`/XHR、配置包、流媒体分片、播放器预览图/雪碧图和 `.z` 数据文件一律不碰，小于阈值的媒体响应交给浏览器。
- **媒体只进面板**：页面自动播放的广告、预告、DASH 轨只出现在右下角媒体面板，不会自动下载；点面板里的条目才会发送给 NDM。只有直接打开媒体地址（顶层导航）才会自动捕获。
- **兼容 NDM 协议**：连接 `ws://127.0.0.1:10007/download`，使用 `neatextension.v1` 子协议；发送 Cookie、Referer、Origin、Content-Type、Content-Disposition、大小、POST 数据和 `X-*` 请求头。
- **支持 HLS**：`.m3u8` 清单以 `hls` 任务发送，单个 `.ts` / `.m4s` 分片会被忽略。
- **Chrome 原生风格**：明暗主题、系统字体、圆角卡片、原生开关，以及紧凑的弹窗和设置页。
- **中英双语**：界面根据浏览器显示语言自动选择简体中文或英文；遇到不支持的语言时回退英文，源码注释同时使用中英文。
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

> “加载已解压”适合开发和自用。若要发布，运行 `npm run package` 生成 `dist/openndm-extension-v<version>.zip`，按 GPL 条款提交到 Chrome 应用商店。

## 使用说明

### 捕获下载

打开网页并点击普通下载链接。如果响应是支持的文件类型，扩展会发送给 NDM，并默认取消 Chrome 中重复的下载。

当 NDM 已连接且站点未被屏蔽时，JavaScript 通过 `chrome.downloads.onCreated` 触发的下载也会被接管。但若页面用 `fetch`/XHR 取回文件再转成 `blob:` 下载（后台系统的导出、附件按钮常见），真实文件名只存在于页面里，NDM 只能按服务器的 `Content-Disposition` 或 URL 命名；这类响应会留给浏览器完成，避免出现「NDM 存成哈希名、浏览器又下一份」的重复下载。

页面播放产生的媒体（视频、音频、HLS 清单）只进入媒体面板，不会自动下载；打开视频网站不会再冒出一堆广告、弹幕或分片下载。需要时在面板里点击对应条目即可。

Chrome 下载时会拿到页面通过 `<a download>` 指定的文件名。扩展在发送前会等一个约 0.7 秒的观察窗：如果 Chrome 有更合适的名字、而 NDM 只能按 URL 或服务器存储名保存，就保留浏览器的副本，不再生成一份命名错误的 NDM 下载；重定向后的下载则直接使用最终地址与对应 Cookie。

### 跳过单次下载

点击链接时按住 **Ctrl**（或在聚焦链接上按住 Ctrl 按 Enter）。扩展会设置一个短暂的绕过窗口，本次下载由浏览器正常处理。

### 屏蔽站点

- 打开弹窗，关闭 **当前站点** 开关；或
- 在页面右键选择 **屏蔽此站点的下载**。

此后该主机及其子域名的所有下载都使用浏览器。可在相同位置取消屏蔽，也可在 **设置 → 屏蔽站点** 中编辑列表。

### 页面媒体

页面包含可直接下载的视频或音频时，右下角默认显示一个最小化的胶囊按钮；点击它展开面板，点击标题栏的最小化按钮（⌄）再次收起。弹窗中的「展开媒体面板」开关与该状态互锁：最小化后显示为关闭，打开即展开当前页面。也可在 **设置 → 捕获 → 页面媒体面板** 中彻底关闭该功能。

面板刻意保持保守：DRM/加密流、`blob:`、`data:` 以及仅通过 MSE 播放的流无法交给 NDM，因此不会列出。

网易邮箱（126 / 163 / yeah.net）的附件下载地址带一次性票据：浏览器请求过之后，NDM 再请求只会收到 `416` 或一个 HTML 错误页，于是只能存成 `readdata.jsp`。因此扩展会把这类链接留给浏览器下载，并在页面上提示一次。

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

## 捕获判定逻辑

一个响应只有在同时满足以下条件时才会被视为下载：

1. URL 为 `http://` 或 `https://`，状态码为 `200`/`203`（`206` 分片响应仅在明确附件时处理）。
2. 捕获与 NDM 已启用，站点未被屏蔽，且没有 Ctrl 绕过。
3. 至少命中一个信号：
   - `Content-Disposition: attachment`；
   - 已知可下载扩展名；
   - 有足够证据的媒体 MIME（大小、元素类型或 HLS 清单）；
   - 主框架 / 对象 / 较大响应上的强制下载 MIME，如 `application/octet-stream`；
   - 非文本 MIME 的主框架文件响应。
4. 不是 HTML 页面、CSS、JavaScript、JSON、XML、图片、字体、WASM 或流媒体分片。

这样可避免误伤网页、API 请求、图片画廊和播放器分片。遇到特殊站点时，可用右键菜单 **使用 NDM 下载** 手动处理。

## NDM 兼容说明

- 端点：`ws://127.0.0.1:10007/download`
- 子协议：`neatextension.v1`
- 任务类型：`normal`、`media`、`hls`
- 协议字段包括 `1:` 方法、`2:` URL、`4:` 页面标题、`5:` 页面 URL、`6:` 类型、`7:` 大小、`8:` Content-Type、`9:` 显示标签，以及 `Origin`、`Referer`、`Cookie`、`Content-Type`、`Content-Disposition`。
- 会读取目标 URL 在各个 Chrome Cookie 存储中的 Cookie，并在可用时包含分区 Cookie。
- Service Worker 通过 Chrome 闹钟保持 WebSocket 活跃，断线后按退避策略重连。

NDM 未运行时不会捕获，下载会留在 Chrome 中。这是刻意设计，避免静默丢失下载。

## 本地化

- 界面文案位于 [`_locales/en/messages.json`](_locales/en/messages.json) 和 [`_locales/zh_CN/messages.json`](_locales/zh_CN/messages.json)。
- Chrome 根据浏览器显示语言自动选择；不支持的语言使用 `default_locale: "en"` 回退英文。
- 新增语言时复制一个语言目录并翻译相同的键即可，无需修改 JavaScript。

## 开发

```bash
npm run check   # 校验清单、资源与国际化键
npm test        # 捕获规则、NDM 消息与打包测试
npm run package # 校验后打包到 dist/openndm-extension-v<version>.zip
```

无需构建，直接在 Chrome 中加载文件夹即可。

发布包只包含运行时文件：脚本从 `manifest.json` 出发，顺着 HTML `<link>`/`<script>`/`<img>`、CSS `url()` 与 ES module `import` 逐层收集，再补上各语言包与 `LICENSE`；测试、脚本、README 等不会进入压缩包。`node scripts/package.mjs --dry-run` 可先查看清单，`--out <file.zip>` 可指定输出位置。时间戳固定，同样的源码重复打包结果一致。

### 版本号

扩展版本号写在 `manifest.json` 的 `version`，并同步到 `package.json`；`npm run check` 会校验两者一致。每次修改都递增最后一位（`0.1.6` → `0.1.7`），除非另有说明。

### 目录结构

```
manifest.json
src/
  background.js          MV3 Service Worker
  content/catcher.js     Ctrl 绕过 + 媒体面板
  lib/                   常量、规则、NDM 客户端、设置、屏蔽列表
  popup/                 工具栏弹窗
  options/               设置页
  ui/base.css            共享的 Chrome 原生风格变量
_locales/                英文与简体中文界面文案
tests/                   Node 单元测试
scripts/validate.mjs     静态校验
scripts/make_icons.py    可重复生成的图标脚本
```

源码注释使用中英双语。

## 隐私

- 无统计、无追踪、无账号、无远程接口。
- Cookie、Referer 与请求元数据只发送给本机 `127.0.0.1` 的 NDM。
- 捕获的 URL 仅保存在内存/会话存储中用于“最近捕获”，点击 **清除** 或重启浏览器后清空。
- 下载可能来自任意网站，因此需要广泛的主机权限。扩展只读取响应元数据；除可选的媒体面板/提示外，不修改页面内容。

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
