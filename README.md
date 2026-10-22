# OpenNDM-Extension

A clean **Manifest V3** rewrite of the Neat Download Manager browser extension. It captures real downloads and page media, sends them to the local NDM app, and stays out of normal browsing.

[中文说明](README.zh-CN.md) · [GPL-3.0-or-later](LICENSE)

## Features

- **Download capture** — direct HTTP(S) downloads, `Content-Disposition` attachments, extensionless download endpoints, and JavaScript-triggered browser downloads.
- **Ctrl to skip** — hold **Ctrl** (or **⌘ Command** on macOS) while clicking a link; that download stays in Chrome. A small toast confirms the bypass.
- **Block sites** — block the current site from the popup or the page context menu. Every download from that host and its subdomains bypasses NDM.
- **Page media panel** — a modern Shadow DOM panel lists `<video>`, `<audio>`, `<source>`, `<embed>`, and `<object>` media, plus network media and Bilibili `__playinfo__` tracks (including MSE pages whose `<video>` uses `blob:`). Click an item to send it to NDM.
- **Precise rules** — HTML pages, scripts, stylesheets, JSON, images, fonts, streaming segments, and player preview sprites (including Bilibili `videoshot`) are not captured. Media responses below the configurable threshold are left to the browser.
- **NDM protocol compatible** — talks to `ws://127.0.0.1:10007/download` with the `neatextension.v1` subprotocol. Sends cookies, referer, origin, content type, content disposition, size, POST body, and `X-*` headers.
- **HLS aware** — `.m3u8` playlists are sent as `hls` tasks, while individual `.ts`/`.m4s` segments are ignored.
- **Chrome-native UI** — light/dark support, system fonts, rounded cards, native switches, and a compact popup/options page.
- **Bilingual** — UI follows the browser display language, with English and Simplified Chinese included. Any unsupported language falls back to English; comments in the source are bilingual.
- **No analytics, no remote server** — request metadata goes only to NDM on `127.0.0.1`.

## Requirements

- Chrome or a Chromium-based browser with Manifest V3 support (Chrome 116+ recommended).
- [Neat Download Manager](https://www.neatdownloadmanager.com/) installed and running.
- NDM’s default local WebSocket port is `10007`. If you changed it in NDM, set the same port in this extension.

## Install (unpacked)

1. Download or clone this folder and keep it in a permanent location.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. Pin **OpenNDM-Extension** to the toolbar.
6. Start NDM, open the popup, and click **Test** if the status is not connected.

> Chrome’s “Load unpacked” mode is for development and personal use. To publish, package the folder as a ZIP and submit it to the Chrome Web Store under the GPL terms.

## Usage

### Capture a download

Open a page and click a normal download link. If the response is a supported file, the extension sends it to NDM and (by default) cancels Chrome’s duplicate download.

JavaScript-triggered downloads are also handled through `chrome.downloads.onCreated` when NDM is connected and the site is not blocked.

### Skip one download

Hold **Ctrl** while clicking the link (or while pressing Enter on a focused link). The extension marks a short bypass window, and Chrome handles the download normally.

### Block a site

- Open the popup and switch **Current site** off, **or**
- Right-click the page and choose **Block downloads on this site**.

All downloads from that host and its subdomains then use the browser. Unblock from the same places. The list is also editable in **Settings → Blocked sites**.

### Page media

When a page contains direct video or audio, a minimised pill appears at the bottom-right by default; click it to expand the panel that lists the discovered media. Use the minimise button (⌄) in the header to collapse it again. The popup's **Expand media panel** switch is interlocked with that state — it shows off while minimised and expands the current page when turned on. Use **Settings → Capture → Page media panel** to disable the feature entirely.

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

The last group is captured only when the server sends `Content-Disposition: attachment` (or when you explicitly choose **Download with NDM** from the context menu).

## How capture decisions work

A response is considered a download when **all** of these are true:

1. The URL is `http://` or `https://` and the status is `200`/`203` (partial `206` responses are ignored unless explicitly attached).
2. Capture and NDM are enabled, the site is not blocked, and no Ctrl bypass is active.
3. At least one signal matches:
   - `Content-Disposition: attachment`;
   - a known downloadable extension;
   - a media MIME type with enough evidence (size, element type, or HLS playlist);
   - a forced-download MIME such as `application/octet-stream` on a main frame, object, or a large response;
   - a main-frame file response with a non-text MIME type.
4. The response is not an HTML page, CSS, JavaScript, JSON, XML, image, font, WASM, or a streaming segment.

This keeps the extension from intercepting pages, API calls, image galleries, and video player fragments. If a site uses an unusual pattern, use the context menu **Download with NDM** for a one-off download.

## NDM compatibility notes

- Endpoint: `ws://127.0.0.1:10007/download`
- Subprotocol: `neatextension.v1`
- Task kinds: `normal`, `media`, `hls`
- Protocol lines include `1:` method, `2:` URL, `4:` page title, `5:` page URL, `6:` kind, `7:` size, `8:` content type, `9:` display label, plus standard `Origin`, `Referer`, `Cookie`, `Content-Type`, and `Content-Disposition` lines.
- Cookies are read from every Chrome cookie store for the target URL, including partitioned cookies when available.
- The service worker keeps the WebSocket alive with Chrome alarms and reconnects with backoff.

If NDM is not running, capture is skipped and downloads stay in Chrome. This is intentional: the extension never silently loses a download.

## Localization

- UI strings live in [`_locales/en/messages.json`](_locales/en/messages.json) and [`_locales/zh_CN/messages.json`](_locales/zh_CN/messages.json).
- Chrome selects the locale from the browser display language; unsupported languages use `default_locale: "en"`.
- To add a language, copy one locale folder, translate the messages, and keep the same keys. No JavaScript changes are required.

## Development

```bash
npm run check   # manifest, resource, and i18n validation
npm test        # capture-rule and NDM message tests
```

No build step is required. Load the folder directly in Chrome.

### Project layout

```
manifest.json
src/
  background.js          MV3 service worker
  content/catcher.js     Ctrl bypass + media panel
  lib/                   constants, rules, NDM client, settings, blocklist
  popup/                 toolbar popup
  options/               settings page
  ui/base.css            shared Chrome-native design tokens
_locales/                English and Simplified Chinese UI strings
tests/                   Node unit tests
scripts/validate.mjs     static checks
scripts/make_icons.py    reproducible icon generator
```

Comments in the source are written in both Chinese and English.

## Privacy

- No analytics, tracking, accounts, or remote endpoints.
- Cookies, referer, and request metadata are sent only to the local NDM app at `127.0.0.1`.
- Captured URLs are kept in memory/session storage for the recent list and are cleared when you press **Clear** or restart the browser.
- The extension needs broad host permissions because downloads can originate from any site. It only reads response metadata and never modifies page content except for the optional media panel/toast.

## Limitations

- DRM-protected or encrypted media cannot be downloaded by NDM.
- `blob:` and `data:` URLs are browser-only and are skipped.
- Bilibili DASH playback may expose separate video and audio tracks; NDM downloads them as separate files and does not merge them.
- Some sites with anti-hotlink logic, one-time tokens, or WebSocket-delivered media may need a manual retry or a browser download.
- NDM must be running for capture. If the port is occupied, change it in both NDM and this extension.

## License

This project is licensed under the **GNU General Public License v3.0 or later** (`GPL-3.0-or-later`). See [LICENSE](LICENSE).

This is an independent rewrite. Neat Download Manager is a separate application by its respective authors; this project is not affiliated with or endorsed by them.
