/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 内容脚本：Ctrl 跳过、页面媒体扫描与现代化媒体面板。
 * Content script: Ctrl bypass, page media scanning, and a modern media panel.
 */
(() => {
  'use strict';

  // 与 src/lib/constants.js 的 MSG 保持一致 / Keep in sync with MSG in src/lib/constants.js.
  const MSG = {
    GET_STATE: 'GET_STATE',
    BYPASS: 'BYPASS',
    DOWNLOAD_URL: 'DOWNLOAD_URL',
    MEDIA_FOUND: 'MEDIA_FOUND',
    PAGE_READY: 'PAGE_READY',
    STATE_CHANGED: 'STATE_CHANGED',
    MEDIA_ADD: 'MEDIA_ADD',
    MEDIA_CLEAR: 'MEDIA_CLEAR',
    PANEL_STATE: 'PANEL_STATE',
    SHOW_TOAST: 'SHOW_TOAST'
  };

  const DOWNLOAD_HINT_RE = /\.(?:zip|rar|7z|tar|gz|bz2|xz|iso|dmg|exe|msi|apk|pdf|docx?|xlsx?|pptx?|epub|mp4|m4v|mkv|webm|mov|avi|mp3|m4a|flac|wav|ogg|opus|ts|m3u8|srt|vtt)(?:[?#]|$)/i;
  const MEDIA_HINT_RE = /\.(?:mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m3u8|mp3|m4a|aac|flac|wav|ogg|oga|opus|m4b)(?:[?#]|$)/i;
  const MEDIA_HOST_SKIP_RE = /(?:^|\.)(?:doubleclick|googlesyndication|adservice|adserver)\./i;

  // 面板位置：存储键、默认留白、贴边阈值、贴边时露出的一条宽度。
  // Panel placement: storage key, default margin, snap distance, and the sliver left visible.
  const PLACE_KEY = 'panelPlace';
  const PLACE_MARGIN = 18;
  const PLACE_SNAP = 24;
  const DOCK_SIDES = ['left', 'right', 'top', 'bottom'];
  // 贴边收成圆球（DOCK_SIZE），沉进边缘后屏内还剩 DOCK_PEEK——要大于图标的一半加边距，
  // 否则下载图标会被切掉。卡片与胶囊之间的间距是 CARD_GAP。
  // The docked pill is a DOCK_SIZE ball with DOCK_PEEK left on screen — enough that the whole
  // icon stays visible. CARD_GAP is the distance between the ball and the card.
  const DOCK_SIZE = 40;
  const DOCK_PEEK = 30;
  const CARD_GAP = 10;
  // 胶囊自由悬浮时的完整宽度，必须与 CSS 里 .launcher 的 width 一致：贴边探出那一下要用它算
  // 夹紧边界，而补间过程中的 offsetWidth 是插值值，量出来会把胶囊夹到视口外。
  // The pill's full width while floating, and it has to match .launcher { width } in CSS: the
  // peek-out is clamped against it, because offsetWidth mid-transition is an interpolated value
  // that would let the pill be pinned partly off screen.
  const PILL_FLOAT_W = 96;
  // 悬停探出用两块静态矩形做迟滞：进 = 沉住时胶囊在屏内留下的那一条，出 = 探出后整颗胶囊，
  // 外沿都再放宽 HOVER_MARGIN。两块都只由 place/dock 算出，绝不挂在元素自己的 pointerenter/
  // leave 上——胶囊一动就重算命中，"弹出"触发"离开"再触发"收起"，指针停在边附近就是无限循环。
  // 进判据只认屏内那一条，是为了"指针真的要碰到球才弹"：按整颗胶囊算，离边还有几十像素就弹了。
  // Two static rectangles give the hover hysteresis: enter is the band the parked ball leaves on
  // screen, keep is the whole pill once slid out, each widened by HOVER_MARGIN. Both are pure
  // functions of place/dock — never the element's own pointerenter/pointerleave, because every
  // slide-out would re-run the hit test and the two states would trigger each other forever. The
  // enter side is only the visible band so the ball answers when the pointer really touches it;
  // using the slid-out pill made it pop out while the pointer was still tens of pixels away.
  const HOVER_MARGIN = 8;

  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }

  const state = {
    settings: {
      captureEnabled: true,
      showMediaPanel: true,
      autoCancelBrowserDownload: true,
      ndmPort: 10007
    },
    ndm: { connected: false },
    siteBlocked: false
  };

  const media = new Map();
  let panel = null;
  let panelList = null;
  let panelCount = null;
  let panelFooter = null;
  let panelHost = null;
  let panelLauncher = null;
  let launcherCount = null;
  // 默认最小化：只在右下角显示胶囊入口 / Minimised by default: only the pill shows.
  let collapsed = true;
  // 面板位置（可视区坐标）与贴边方向；dock 为空表示胶囊自由悬浮。
  // The pill's placement in client-box pixels; an empty dock means it floats freely.
  let place = { left: Number.NaN, top: Number.NaN, dock: '' };
  // 卡片在胶囊上方还是下方，一旦展开就定下来，拖动中不翻转——否则越过阈值那一下卡片会跳。
  // Whether the card opens above or below the pill is decided when it opens, and frozen mid-drag,
  // or the card would jump the moment the pointer crosses the threshold.
  let cardBelow = false;
  let dragSession = null;
  let dragMoved = false;
  // 悬停只作用在"当前可见的那块"上：贴边时它就是把手，不再另画一个把手按钮。
  // Hover applies to whatever is visible; when docked that element is itself the handle.
  let hoverMover = false;
  // 刚吸附/刚收回边上时先解除悬停：指针就停在刚形成的探出区里，不留神会立刻弹回屏内，
  // 看起来像"拖到边上没收起来"。指针彻底走出这块区域再回来时才重新待命。
  // A fresh snap or fold disarms hover — the pointer is sitting inside the zone that was just
  // created, and peeking straight back out would read as the gesture failing. It re-arms once the
  // pointer has left that zone and come back.
  let hoverArmed = true;
  // 从贴边的胶囊点开面板时记住那条边：再收起就回到原来的边上，而不是留在刚脱离的位置。
  // 一旦拖动就作废——用户已经把它挪走了，收起时不该再吸回老边缘。
  // Remembered when a docked pill is clicked open, so folding goes back to that same edge instead
  // of leaving the pill floating where the release put it. A drag clears it: the user moved it, so
  // there is no edge to return to.
  let dockResume = '';
  let peeking = false;
  let placeSaveTimer = null;
  let scanTimer = null;
  let stateReady = false;
  let bilibiliParsed = false;
  let observedRoot = null;
  let lastHref = location.href;
  let bypassSentAt = 0;
  let toastTimer = null;
  let toastHost = null;
  let locationTimer = null;

  // 读取国际化文案 / Read a localized string with an English fallback.
  function t(key, fallback) {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Ctrl bypass                                                              */
  /* ------------------------------------------------------------------------ */

  // 提前通知后台，确保后续下载事件放行 / Tell the worker early so the following download is not captured.
  function announceBypass() {
    const now = Date.now();
    if (now - bypassSentAt < 450) return;
    bypassSentAt = now;
    void sendMessage({ type: MSG.BYPASS, ttl: 4000 });
  }

  function hasBypassModifier(event) {
    return Boolean(event.ctrlKey || event.metaKey);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Control' || event.key === 'Meta' || (hasBypassModifier(event) && event.key === 'Enter')) {
      announceBypass();
    }
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (hasBypassModifier(event)) announceBypass();
  }, { capture: true, passive: true });

  document.addEventListener('mousedown', (event) => {
    if (hasBypassModifier(event)) announceBypass();
  }, { capture: true, passive: true });

  document.addEventListener('click', (event) => {
    if (!hasBypassModifier(event)) return;
    announceBypass();
    if (isTop && looksLikeDownloadLink(event.target)) {
      showToast(t('bypassToast', 'NDM skipped · browser download'));
    }
  }, { capture: true, passive: true });

  function looksLikeDownloadLink(target) {
    if (!(target instanceof Element)) return false;
    const anchor = target.closest('a[href]');
    if (!anchor) return false;
    if (anchor.hasAttribute('download') && honoursDownloadAttribute(anchor.href)) return true;
    return DOWNLOAD_HINT_RE.test(anchor.href || '');
  }

  // 跨源链接上浏览器会忽略 download 属性，只剩一次普通导航，别谎称替用户做了什么。
  // The browser ignores `download` on cross-origin links, leaving a plain navigation; do not
  // claim the bypass did something it could not have done.
  function honoursDownloadAttribute(href) {
    try {
      const url = new URL(href, location.href);
      if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
      return url.origin === location.origin;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Media scanning                                                           */
  /* ------------------------------------------------------------------------ */

  function scheduleScan(delay = 900) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanMedia, delay);
  }

  function scanMedia() {
    if (!stateReady) return;
    if (state.siteBlocked || !state.settings.captureEnabled || !state.settings.showMediaPanel) {
      if (panel) renderPanel();
      return;
    }

    const found = [];
    const add = (rawUrl, kind, label, ext) => {
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return false;
      try {
        const host = new URL(rawUrl).hostname;
        if (MEDIA_HOST_SKIP_RE.test(host)) return false;
      } catch {
        return false;
      }
      if (media.has(rawUrl)) return false;
      const item = {
        url: rawUrl,
        kind,
        label: label || filenameOf(rawUrl) || (kind === 'audio' ? t('audioLabel', 'Audio') : t('videoLabel', 'Video')),
        ext: ext || extensionOf(rawUrl),
        size: 0,
        pageUrl: isTop ? location.href : '',
        frameUrl: location.href
      };
      media.set(rawUrl, item);
      if (media.size > 30) {
        const first = media.keys().next().value;
        if (first) media.delete(first);
      }
      found.push(item);
      return true;
    };

    document.querySelectorAll('video, audio').forEach((element) => {
      const kind = element.tagName === 'AUDIO' ? 'audio' : 'video';
      const label = mediaLabel(element);
      const current = element.currentSrc || element.src || '';
      add(current, kind, label, '');
      element.querySelectorAll('source[src]').forEach((source) => {
        add(source.src, kind, label || source.getAttribute('title') || '', typeToExt(source.getAttribute('type')));
      });
    });

    document.querySelectorAll('source[src]').forEach((source) => {
      if (!source.closest('video, audio')) return;
      const parent = source.closest('video, audio');
      const kind = parent?.tagName === 'AUDIO' ? 'audio' : 'video';
      add(source.src, kind, mediaLabel(parent), typeToExt(source.getAttribute('type')));
    });

    document.querySelectorAll('embed[src], object[data]').forEach((element) => {
      const url = element.getAttribute('src') || element.getAttribute('data') || '';
      const type = String(element.getAttribute('type') || '').toLowerCase();
      if (type && !type.startsWith('video/') && !type.startsWith('audio/') && !type.includes('flash')) return;
      if (!type && !MEDIA_HINT_RE.test(url)) return;
      add(url, type.startsWith('audio/') ? 'audio' : 'video', mediaLabel(element), typeToExt(type));
    });

    // B 站使用 MSE，<video> 的 currentSrc 通常是 blob:，需要从 __playinfo__ 取真实轨道。
    // Bilibili uses MSE, so read real DASH tracks from __playinfo__.
    if (!bilibiliParsed) scanBilibiliPlayInfo(add);

    if (found.length) {
      renderPanel();
      void sendMessage({
        type: MSG.MEDIA_FOUND,
        pageUrl: isTop ? location.href : '',
        items: found
      });
    } else if (media.size) {
      renderPanel();
    }
  }

  function mediaLabel(element) {
    if (!element) return '';
    const explicit = element.getAttribute('title')
      || element.getAttribute('aria-label')
      || element.getAttribute('data-title')
      || '';
    if (explicit.trim()) return explicit.trim().slice(0, 140);
    const figure = element.closest('figure');
    const caption = figure?.querySelector('figcaption')?.textContent || '';
    if (caption.trim()) return caption.trim().replace(/\s+/g, ' ').slice(0, 120);
    return (filenameOf(element.currentSrc || element.src || element.getAttribute('data') || '')
      || document.title
      || '').slice(0, 140);
  }

  function filenameOf(value) {
    try {
      const last = decodeURIComponent(new URL(value).pathname.split('/').pop() || '');
      return last.replace(/\+/g, ' ').slice(0, 120);
    } catch {
      return '';
    }
  }

  function extensionOf(value) {
    try {
      const path = new URL(value).pathname;
      const last = path.split('/').pop() || '';
      const dot = last.lastIndexOf('.');
      return dot > 0 ? last.slice(dot + 1).toUpperCase().slice(0, 8) : '';
    } catch {
      return '';
    }
  }

  function typeToExt(type) {
    const value = String(type || '').toLowerCase();
    if (value.includes('mpegurl')) return 'M3U8';
    if (value.includes('mp4')) return 'MP4';
    if (value.includes('webm')) return 'WEBM';
    if (value.includes('matroska')) return 'MKV';
    if (value.includes('mpeg')) return 'MPEG';
    if (value.includes('quicktime')) return 'MOV';
    if (value.includes('ogg')) return 'OGG';
    if (value.includes('mp3')) return 'MP3';
    if (value.includes('wav')) return 'WAV';
    return '';
  }

  /**
   * 读取 B 站页面脚本中的 __playinfo__，提取 DASH/渐进视频轨道。
   * Read Bilibili __playinfo__ from page scripts and collect DASH/progressive tracks.
   */
  function scanBilibiliPlayInfo(add) {
    if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) return;

    for (const script of document.scripts) {
      if (script.src) continue;
      const text = script.textContent || '';
      if (!text.includes('__playinfo__')) continue;
      const marker = text.indexOf('__playinfo__');
      const start = text.indexOf('{', marker);
      if (start < 0) continue;
      const jsonText = readBalancedJson(text, start);
      if (!jsonText) continue;

      let payload;
      try {
        payload = JSON.parse(jsonText);
      } catch {
        continue;
      }
      const play = payload?.data || payload;
      if (!play || typeof play !== 'object') continue;

      let parsed = false;
      if (play.dash && typeof play.dash === 'object') {
        parsed = true;
        for (const track of play.dash.video || []) addBilibiliTrack(track, 'video', add);
        for (const track of play.dash.audio || []) addBilibiliTrack(track, 'audio', add);
      }
      if (Array.isArray(play.durl)) {
        parsed = true;
        for (const entry of play.durl) {
          const raw = entry?.url || entry?.baseUrl || entry?.base_url;
          if (!raw) continue;
          const url = absoluteUrl(raw);
          if (url) add(url, 'video', t('videoTrack', 'Video track'), extensionOf(url) || 'MP4');
        }
      }
      if (parsed) {
        bilibiliParsed = true;
        return;
      }
    }
  }

  function addBilibiliTrack(track, kind, add) {
    if (!track || typeof track !== 'object') return;
    const raw = track.baseUrl || track.base_url || track.url;
    const url = absoluteUrl(raw);
    if (!url) return;
    const quality = track.height
      ? `${track.height}P`
      : track.bandwidth
        ? `${Math.round(Number(track.bandwidth) / 1000)} Kbps`
        : '';
    const label = `${t(kind === 'audio' ? 'audioTrack' : 'videoTrack', kind === 'audio' ? 'Audio track' : 'Video track')}${quality ? ` · ${quality}` : ''}`;
    add(url, kind, label, extensionOf(url) || 'MP4');
  }

  function absoluteUrl(value) {
    try {
      const url = new URL(value, location.href);
      return /^https?:$/i.test(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  // 从指定 { 开始提取配对 JSON，正确处理字符串中的括号。
  // Extract a balanced JSON object starting at a {, respecting quoted braces.
  function readBalancedJson(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return '';
  }

  /* ------------------------------------------------------------------------ */
  /* Media panel                                                              */
  /* ------------------------------------------------------------------------ */

  function ensurePanel() {
    if (!isTop || panelHost) return;
    panelHost = document.createElement('div');
    panelHost.id = 'ndm-media-panel-host';
    // 位置补间只给松手吸附用：拖动时 onDragMove 会临时关掉它，否则卡片跟不上手。
    // The left/top easing is for the snap only; the drag turns it off so the card follows the pointer.
    panelHost.style.cssText = 'all: initial; position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; pointer-events: none; transition: left .2s cubic-bezier(.22, .75, .25, 1), top .2s cubic-bezier(.22, .75, .25, 1);';
    const shadow = panelHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        /* 统一样式变量：圆角、间距、主色、字色、阴影、动效一处定义，卡片与胶囊共用同一套。
           Design tokens: one place defines radii, spacing, accents, text colours, shadow and
           motion, shared by the card and the pill. */
        .panel, .launcher {
          --ndm-radius-card: 14px;
          --ndm-radius-soft: 10px;
          --ndm-radius-pill: 999px;
          --ndm-gap-xs: 4px;
          --ndm-gap-sm: 8px;
          --ndm-gap-md: 12px;
          --ndm-brand: #1e8e3e;
          --ndm-accent: #1e8e3e;
          --ndm-accent-ink: #137333;
          --ndm-accent-soft: #e6f4ea;
          --ndm-action: #1a73e8;
          --ndm-action-ink: #1967d2;
          --ndm-action-soft: #e8f0fe;
          --ndm-surface: #ffffff;
          --ndm-surface-hover: #f8f9fa;
          --ndm-border: #dadce0;
          --ndm-divider: #e8eaed;
          --ndm-text: #202124;
          --ndm-text-muted: #5f6368;
          --ndm-text-faint: #b6bcc4;
          --ndm-warn: #f9ab00;
          --ndm-danger: #d93025;
          --ndm-shadow: 0 12px 36px rgba(32, 33, 36, .22), 0 2px 6px rgba(32, 33, 36, .12);
          --ndm-ease: cubic-bezier(.22, .75, .25, 1);
          --ndm-motion: .22s var(--ndm-ease);
          --ndm-font: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        }
        /* 尺寸即所见：卡片 326px、圆球 40px 都含边框，贴边留白与夹具断言才不会各算一套。
           Border-box everywhere: the card's 326px and the ball's 40px include their borders, so the
           dock peek and the fixture assertions measure the same box. */
        .panel, .panel *, .launcher { box-sizing: border-box; }
        @media (prefers-color-scheme: dark) {
          .panel, .launcher {
            --ndm-accent: #81c995;
            --ndm-accent-ink: #81c995;
            --ndm-accent-soft: #173a28;
            --ndm-action-ink: #8ab4f8;
            --ndm-action-soft: #1a3a63;
            --ndm-surface: #292a2d;
            --ndm-surface-hover: #3c4043;
            --ndm-border: #3c4043;
            --ndm-divider: #3c4043;
            --ndm-text: #e8eaed;
            --ndm-text-muted: #9aa0a6;
            --ndm-text-faint: #5f6368;
            --ndm-shadow: 0 14px 40px rgba(0, 0, 0, .55);
          }
        }
        /* 卡片是胶囊的浮层：绝对定位在 host（=胶囊原点）内，由 applyCardAnchor() 算出偏移，
           自己贴到视口内。它不参与贴边，所以沉入边缘的只有胶囊。
           The card is a popover of the pill: absolutely positioned inside the host (the pill's
           origin) and offset by applyCardAnchor(). It never docks — only the pill sinks. */
        .panel {
          position: absolute;
          left: 0;
          top: 0;
          width: 326px;
          max-height: min(430px, 80vh);
          display: none;
          flex-direction: column;
          overflow: hidden;
          color: var(--ndm-text);
          background: var(--ndm-surface);
          border: 1px solid var(--ndm-border);
          border-radius: var(--ndm-radius-card);
          box-shadow: var(--ndm-shadow);
          font: 13px/1.4 var(--ndm-font);
          animation: ndm-in .18s ease-out;
          pointer-events: auto;
        }
        @keyframes ndm-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
        .head { display: flex; align-items: center; gap: var(--ndm-gap-sm); padding: var(--ndm-gap-md) var(--ndm-gap-sm) var(--ndm-gap-sm) var(--ndm-gap-md); border-bottom: 1px solid var(--ndm-divider); cursor: grab; user-select: none; touch-action: none; }
        .panel.moving .head { cursor: grabbing; }
        .grip { width: 10px; flex: none; display: grid; place-items: center; color: var(--ndm-text-faint); }
        .grip svg { width: 10px; height: 14px; fill: currentColor; display: block; }
        .brand { width: 26px; height: 26px; border-radius: var(--ndm-radius-soft); background: var(--ndm-brand); display: grid; place-items: center; flex: none; }
        .brand svg { width: 15px; height: 15px; display: block; fill: #fff; }
        .titles { min-width: 0; flex: 1; }
        .title { display: block; font-weight: 600; font-size: 13px; letter-spacing: .1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sub { display: block; margin-top: 1px; color: var(--ndm-text-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .count { min-width: 20px; height: 20px; padding: 0 var(--ndm-gap-xs); border-radius: var(--ndm-radius-pill); background: var(--ndm-action-soft); color: var(--ndm-action-ink); font-size: 11px; font-weight: 600; display: grid; place-items: center; box-sizing: border-box; }
        .icon-btn { width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: var(--ndm-text-muted); display: grid; place-items: center; cursor: pointer; padding: 0; }
        .icon-btn:hover { background: var(--ndm-surface-hover); color: var(--ndm-text); }
        .icon-btn:focus-visible { outline: 2px solid var(--ndm-action); outline-offset: 1px; }
        .icon-btn svg { width: 16px; height: 16px; fill: currentColor; }
        .list { overflow: auto; padding: var(--ndm-gap-sm); }
        .list::-webkit-scrollbar { width: 8px; }
        .list::-webkit-scrollbar-thumb { background: var(--ndm-border); border-radius: var(--ndm-radius-pill); }
        .item { display: flex; align-items: center; gap: var(--ndm-gap-md); padding: var(--ndm-gap-sm); border-radius: var(--ndm-radius-soft); }
        .item:hover { background: var(--ndm-surface-hover); }
        .thumb { width: 34px; height: 34px; border-radius: var(--ndm-radius-soft); background: var(--ndm-action-soft); color: var(--ndm-action-ink); display: grid; place-items: center; flex: none; }
        .thumb.audio { background: var(--ndm-accent-soft); color: var(--ndm-accent-ink); }
        .thumb svg { width: 17px; height: 17px; fill: currentColor; }
        .info { min-width: 0; flex: 1; }
        .name { display: block; color: var(--ndm-text); font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meta { display: block; margin-top: 2px; color: var(--ndm-text-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .get { width: 30px; height: 30px; flex: none; border: 0; border-radius: var(--ndm-radius-soft); background: var(--ndm-action); color: #fff; display: grid; place-items: center; cursor: pointer; padding: 0; }
        .get:hover { filter: brightness(.94); }
        .get:disabled { opacity: .62; cursor: default; }
        .get:focus-visible { outline: 2px solid var(--ndm-action); outline-offset: 2px; }
        .get svg { width: 15px; height: 15px; fill: currentColor; }
        .foot { padding: var(--ndm-gap-sm) var(--ndm-gap-md); border-top: 1px solid var(--ndm-divider); color: var(--ndm-text-muted); font-size: 11px; display: flex; align-items: center; gap: var(--ndm-gap-xs); }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ndm-accent); flex: none; }
        .dot.off { background: var(--ndm-warn); }
        .dot.blocked { background: var(--ndm-danger); }
        /* 胶囊是定位基准：只有它能贴边。展开卡片时它让位（visibility 隐藏，仍占位可量尺寸），
           卡片作为它的浮层按同一原点摆出去，所以收起/展开不会跳位。
           The pill is the placement reference and the only thing that docks. While the card is
           open it is hidden with visibility — still laid out, so its size stays measurable — and
           the card is placed from the same origin, which is why expanding never shifts anything. */
        .launcher {
          display: none;
          align-items: center;
          justify-content: center;
          gap: var(--ndm-gap-sm);
          width: 96px;
          height: 40px;
          padding: 0 var(--ndm-gap-md);
          border: 1px solid var(--ndm-border);
          border-radius: var(--ndm-radius-pill);
          background: var(--ndm-surface);
          color: var(--ndm-accent);
          cursor: grab;
          box-shadow: var(--ndm-shadow);
          font: 600 12.5px/1 var(--ndm-font);
          animation: ndm-in .18s ease-out;
          pointer-events: auto;
          touch-action: none;
          user-select: none;
          transition: transform var(--ndm-motion), width var(--ndm-motion), padding var(--ndm-motion), gap var(--ndm-motion), border-radius var(--ndm-motion);
        }
        .launcher.moving { transition: none; cursor: grabbing; }
        .launcher:hover { background: var(--ndm-surface-hover); }
        .launcher:focus-visible { outline: 2px solid var(--ndm-action); outline-offset: 2px; }
        .launcher svg { width: 17px; height: 17px; fill: currentColor; flex: none; }
        .launcher-count { min-width: 22px; max-width: 34px; height: 22px; padding: 0 var(--ndm-gap-xs); border-radius: var(--ndm-radius-pill); background: var(--ndm-accent-soft); color: var(--ndm-accent-ink); font-size: 11px; display: grid; place-items: center; box-sizing: border-box; overflow: hidden; transition: min-width var(--ndm-motion), max-width var(--ndm-motion), padding var(--ndm-motion), opacity var(--ndm-motion); }
        /* 贴边时收成 40px 圆球：宽度、内边距、间隙、徽标一起补间，胶囊是"缩"进边里的，
           不是瞬间换成另一个形状；徽标先让位——半截计数比没有计数更乱。
           Docking morphs the pill into a 40px ball: width, padding, gap and the badge all tween,
           so it shrinks into the edge rather than swapping shapes in one frame. The count steps
           aside first — a half-cut number looks worse than no number. */
        .launcher.docked { width: 40px; padding: 0; gap: 0; border-radius: 50%; }
        .launcher.docked .launcher-count { min-width: 0; max-width: 0; width: 0; padding: 0; opacity: 0; overflow: hidden; }
      </style>
      <section class="panel" role="dialog" aria-label="${escapeHtml(t('mediaPanelTitle', 'Page media'))}">
        <header class="head" title="${escapeHtml(t('mediaPanelDrag', 'Drag to move, release near an edge to hide'))}">
          <span class="grip" aria-hidden="true">
            <svg viewBox="0 0 10 14"><circle cx="2.6" cy="3" r="1.4"/><circle cx="7.4" cy="3" r="1.4"/><circle cx="2.6" cy="7" r="1.4"/><circle cx="7.4" cy="7" r="1.4"/><circle cx="2.6" cy="11" r="1.4"/><circle cx="7.4" cy="11" r="1.4"/></svg>
          </span>
          <span class="brand" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L10 13.2V3h2zm-8 16h16v2H4v-2z"/></svg>
          </span>
          <div class="titles">
            <span class="title">${escapeHtml(t('mediaPanelTitle', 'Page media'))}</span>
            <span class="sub">${escapeHtml(t('mediaPanelSubtitle', 'Download with Neat Download Manager'))}</span>
          </div>
          <span class="count">0</span>
          <button class="icon-btn minimize" type="button" title="${escapeHtml(t('minimize', 'Minimize'))}" aria-label="${escapeHtml(t('minimize', 'Minimize'))}">
            <svg viewBox="0 0 24 24"><path d="M12 15.6 6.4 10l1.4-1.4L12 12.8l4.2-4.2L17.6 10z"/></svg>
          </button>
        </header>
        <div class="list" role="list"></div>
        <footer class="foot"><span class="dot"></span><span class="status"></span></footer>
      </section>
      <button class="launcher" type="button" title="${escapeHtml(t('mediaPanelOpen', 'Show media panel'))}" aria-label="${escapeHtml(t('mediaPanelOpen', 'Show media panel'))}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L10 13.2V3h2zm-8 16h16v2H4v-2z"/></svg>
        <span class="launcher-count">0</span>
      </button>
    `;
    adoptShadowStyles(shadow);
    (document.body || document.documentElement).appendChild(panelHost);
    panel = shadow.querySelector('.panel');
    panelList = shadow.querySelector('.list');
    panelCount = shadow.querySelector('.count');
    panelFooter = shadow.querySelector('.status');
    panelLauncher = shadow.querySelector('.launcher');
    launcherCount = shadow.querySelector('.launcher-count');
    shadow.querySelector('.minimize').addEventListener('click', () => {
      setPanelCollapsed(true);
    });
    // 最小化后通过胶囊按钮重新展开 / Expand the panel again from the collapsed launcher.
    panelLauncher?.addEventListener('click', () => {
      // 刚拖动过就不算点击展开 / a drag on the pill must not also expand the card.
      if (dragMoved) return;
      // 贴边时点胶囊要先脱离：否则刚展开的卡片立刻又贴回边上，只剩一条边儿。
      // 记下这条边，收起时好回到原处（不记就停在脱离后的位置上飘着）。
      // Release the dock first, or the freshly expanded card would park again as a sliver.
      // Remember the side so folding returns to it instead of leaving the pill where it was freed.
      dockResume = place.dock;
      // 探出只是贴边的一种临时外观，脱离贴边就该收回去，否则卡片关闭时它按 `peeking` 判定
      // "没沉住"，胶囊会停在探出的位置上飘着。
      // The peek is only a look the docked pill takes; releasing the dock has to drop it too, or
      // isParked() reads "not parked" when the card closes and the pill ends up floating where
      // the slid-out origin was — the docking looks lost.
      peeking = false;
      hoverMover = false;
      releaseDock();
      setPanelCollapsed(false);
    });
    bindPanelPlacement(shadow);
  }

  /* ------------------------------------------------------------------------ */
  /* Panel placement: free drag + edge docking                                 */
  /* 面板位置：自由拖动与贴边隐藏                                                */
  /* ------------------------------------------------------------------------ */

  function clampNumber(value, min, max) {
    if (max < min) return min;
    return Math.min(max, Math.max(min, value));
  }

  // 横向要用不含滚动条的可视宽度：window.innerWidth 既包含 classic 滚动条轨道，
  // Windows 的占位式细滚动条也照样占位，按它定位会把卡片和把手压到滚动条下面。
  // Use the client width, not innerWidth: innerWidth includes classic scrollbar tracks and
  // Windows' overlaid thin bars still reserve space, which would paint over the panel.
  function viewportWidth() {
    return document.documentElement.clientWidth || window.innerWidth;
  }

  // 纵向同理：页面有横向滚动条时，紧贴 innerHeight 的元素会被它盖住下半截。
  // Same reasoning vertically: a horizontal scrollbar would otherwise cover the bottom row.
  function viewportHeight() {
    return document.documentElement.clientHeight || window.innerHeight;
  }

  function normalizePlace(value) {
    const source = value && typeof value === 'object' ? value : {};
    const left = Number(source.left);
    const top = Number(source.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return {
      left,
      top,
      dock: DOCK_SIDES.includes(source.dock) ? source.dock : ''
    };
  }

  // 位置只是界面偏好：读写失败都不能影响捕获。
  // Placement is a UI preference: storage failures must never affect capture.
  function loadPlace() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(PLACE_KEY, (stored) => {
          void chrome.runtime.lastError;
          resolve(normalizePlace(stored && stored[PLACE_KEY]));
        });
      } catch {
        resolve(null);
      }
    });
  }

  function savePlace() {
    clearTimeout(placeSaveTimer);
    placeSaveTimer = setTimeout(() => {
      try {
        // 只存胶囊的位置与贴边方向：卡片是它的浮层，跟着算出来，不需要单独记。
        // Only the pill's position and dock side are stored; the card is derived from them.
        chrome.storage.local.set({
          [PLACE_KEY]: {
            left: Math.round(place.left),
            top: Math.round(place.top),
            dock: place.dock
          }
        }, () => {
          void chrome.runtime.lastError;
        });
      } catch {
        // 忽略：位置丢失无关功能 / ignore — losing the position is not functional.
      }
    }, 200);
  }

  // 定位基准永远是胶囊：它常驻、尺寸稳定（贴边时收成 DOCK_SIZE 的圆球）。
  // 探出/悬浮时按整颗胶囊（PILL_FLOAT_W）算边界，否则滑回屏内的那半截会被视口切掉。
  // The pill is always the placement reference: it stays on screen, a DOCK_SIZE ball when parked
  // and the full PILL_FLOAT_W pill otherwise — using the ball's width while peeked out would let
  // the slid-out half hang off the edge and get clipped.
  function isParked() {
    return Boolean(place.dock) && !peeking && !dragSession;
  }

  function placementBox() {
    return {
      width: isParked() ? DOCK_SIZE : PILL_FLOAT_W,
      height: panelLauncher?.offsetHeight || DOCK_SIZE
    };
  }

  // 松手时只有真的贴到某条边才吸附。拖的是卡片时按「卡片 + 胶囊」的并集算：卡片贴着左边时，
  // 作为锚点的胶囊可能还在一张卡片宽之外；卡片永远开在胶囊上方，够不到底边时轮到胶囊贴住底边。
  // 并集让上下左右四条边都能被这个手势触发，而不只是右和下。
  // Snap only when the dragged thing really reaches an edge. When the card was dragged, measure
  // the union of the card and the pill: the card can sit against the left edge while its anchor
  // pill is still a card-width away, and because the card opens above the pill it can never touch
  // the bottom edge itself — the pill does. The union is what makes all four sides reachable.
  function dockSideFor(mover) {
    const pill = placementBox();
    let left = place.left;
    let top = place.top;
    let right = place.left + pill.width;
    let bottom = place.top + pill.height;
    if (mover === panel && panel && !collapsed) {
      const card = panel.getBoundingClientRect();
      left = Math.min(left, card.left);
      top = Math.min(top, card.top);
      right = Math.max(right, card.right);
      bottom = Math.max(bottom, card.bottom);
    }
    const gaps = {
      left,
      right: viewportWidth() - right,
      top,
      bottom: viewportHeight() - bottom
    };
    let side = '';
    let smallest = PLACE_SNAP;
    for (const candidate of DOCK_SIDES) {
      if (gaps[candidate] < smallest) {
        smallest = gaps[candidate];
        side = candidate;
      }
    }
    return side;
  }

  function applyPlace() {
    if (!panelHost) return;
    const box = placementBox();
    let left = Number.isFinite(place.left) ? place.left : viewportWidth() - box.width - PLACE_MARGIN;
    let top = Number.isFinite(place.top) ? place.top : viewportHeight() - box.height - PLACE_MARGIN;

    // 贴边时把停靠轴钉在可视区边上，圆球沉进边里，只留 DOCK_PEEK 在屏内。
    // While docked, pin the docked axis to the client-box edge so the ball sinks in and only
    // DOCK_PEEK stays on screen.
    if (place.dock === 'left') left = 0;
    else if (place.dock === 'right') left = viewportWidth() - box.width;
    else if (place.dock === 'top') top = 0;
    else if (place.dock === 'bottom') top = viewportHeight() - box.height;

    left = Math.round(clampNumber(left, 0, Math.max(0, viewportWidth() - box.width)));
    top = Math.round(clampNumber(top, 0, Math.max(0, viewportHeight() - box.height)));
    place = { left, top, dock: place.dock };

    panelHost.style.left = `${left}px`;
    panelHost.style.top = `${top}px`;
    panelHost.style.right = 'auto';
    panelHost.style.bottom = 'auto';
    panelHost.dataset.dock = place.dock;
    panelHost.dataset.left = String(left);
    panelHost.dataset.top = String(top);

    // 只有胶囊会沉进边缘；悬停或拖动时整颗滑回屏内，卡片从来不贴边。
    // Only the pill sinks into the edge, sliding fully back on hover or drag; the card never docks.
    const sinks = {
      left: `translateX(calc(-100% + ${DOCK_PEEK}px))`,
      right: `translateX(calc(100% - ${DOCK_PEEK}px))`,
      top: `translateY(calc(-100% + ${DOCK_PEEK}px))`,
      bottom: `translateY(calc(100% - ${DOCK_PEEK}px))`
    };
    const parked = isParked();
    if (panelLauncher) {
      panelLauncher.style.transform = parked ? sinks[place.dock] : '';
      panelLauncher.classList.toggle('docked', parked);
    }

    applyCardAnchor();
  }

  // 卡片贴在胶囊旁边，默认右对齐、开在上方；上方放不下才开到下方，左右只夹不翻。
  // 只夹不翻是有意的：翻转会跟着鼠标越过阈值，拖动中卡片会瞬移几十像素，看起来像 bug。
  // 夹进可视区就够了——卡片永远完整可见，也不会压住滚动条。
  // The card hugs the pill, right-aligned and above it by default, flipping below only when there
  // is no room up there. Horizontally it is clamped, never flipped: a flip would hinge on the
  // pointer crossing a threshold and make the card teleport mid-drag. Clamping keeps it fully
  // visible and clear of the scrollbar, which is all the flip was ever for.
  function applyCardAnchor() {
    if (!panel || collapsed) return;
    const pill = placementBox();
    const width = panel.offsetWidth || 326;
    const height = panel.offsetHeight || 240;
    if (!dragSession) cardBelow = place.top - (height + CARD_GAP) < CARD_GAP;
    const y = cardBelow ? pill.height + CARD_GAP : -(height + CARD_GAP);
    panel.style.left = `${Math.round(clampNumber(pill.width - width, -place.left, Math.max(-place.left, viewportWidth() - place.left - width)))}px`;
    panel.style.top = `${Math.round(clampNumber(y, -place.top + CARD_GAP, Math.max(-place.top + CARD_GAP, viewportHeight() - place.top - height)))}px`;
  }

  // 点可见的那块（胶囊或卡片本体）就把它从边上放回来。
  // Clicking the visible element — the pill or the card body — pulls it back off the edge.
  function releaseDock() {
    if (!place.dock) return;
    place = { left: place.left, top: place.top, dock: '' };
    applyPlace();
    savePlace();
  }

  // 悬停判定区：进/出两块矩形，都只由 place、贴边方向和可视区算出来。
  // 关键是它们都不参考元素此刻的位置——沉在边里还是滑在外面都不能改变这两块区域，否则胶囊
  // 一动判定就跟着动，弹出与收起互相触发，指针停在边附近就无限循环。
  // 进入只看"沉住时屏内露出的那一条"（DOCK_PEEK × 球），所以指针要真的走到边上才请它出来；
  // 按探出后整颗胶囊的矩形判定，会提前几十像素就把球弹出来。
  // The hover decision uses two rectangles derived only from place, the docked side and the
  // client box. Neither looks at where the element currently is: parked or peeked they stay put,
  // otherwise the pill's own movement re-runs the test and the two states trigger each other
  // forever. Entering honors only the band the ball leaves on screen (DOCK_PEEK wide) — using the
  // slid-out pill for that peeks the ball a whole pill-width before the pointer reaches the edge.
  function hoverRects() {
    const peekW = PILL_FLOAT_W;
    const peekH = panelLauncher?.offsetHeight || DOCK_SIZE;
    const ball = DOCK_SIZE;
    const vw = viewportWidth();
    const vh = viewportHeight();
    const left = clampNumber(Number.isFinite(place.left) ? place.left : vw - peekW - PLACE_MARGIN, 0, Math.max(0, vw - peekW));
    const top = clampNumber(Number.isFinite(place.top) ? place.top : vh - peekH - PLACE_MARGIN, 0, Math.max(0, vh - peekH));
    const peeked = { left, top, width: peekW, height: peekH };
    switch (place.dock) {
      // 沉住时球就贴在边上，屏内只剩 DOCK_PEEK 那一条，另一轴仍是球的尺寸。
      // Parked, the ball is flush with the edge: DOCK_PEEK of it stays visible, the other axis is the ball.
      case 'left': return { enter: { left: 0, top, width: DOCK_PEEK, height: ball }, keep: peeked };
      case 'right': return { enter: { left: vw - DOCK_PEEK, top, width: DOCK_PEEK, height: ball }, keep: peeked };
      case 'top': return { enter: { left, top: 0, width: ball, height: DOCK_PEEK }, keep: peeked };
      case 'bottom': return { enter: { left, top: vh - DOCK_PEEK, width: ball, height: DOCK_PEEK }, keep: peeked };
      default: return { enter: peeked, keep: peeked };
    }
  }

  function inRect(rect, x, y, margin) {
    return x >= rect.left - margin && x <= rect.left + rect.width + margin
      && y >= rect.top - margin && y <= rect.top + rect.height + margin;
  }

  // 进：指针要落到屏内那一条上（允许 HOVER_MARGIN 的容差）；出：要彻底走出探出后整颗胶囊再
  // 放宽 HOVER_MARGIN。两者之间的差集就是迟滞带——在探出的胶囊上逛不会收回，1px 抖动不翻状态。
  // Two rectangles, hysteresis style: peeking starts on the visible sliver (plus HOVER_MARGIN of
  // slack), parking needs the pointer beyond the slid-out pill by HOVER_MARGIN again. The
  // difference between them is dead space, so wandering over the open pill does not fold it back
  // and 1 px of tremor on a border flips nothing.
  function setHoverFromPointer(x, y) {
    if (!panelHost) return;
    // 只有贴边才有"探出"可言：展开时 dock 一定为空（贴边与展开互斥）。
    // Only a docked pill can peek: while the card is open the dock is empty by construction.
    if (!place.dock || dragSession) {
      if (hoverMover) {
        hoverMover = false;
        updatePeek();
      }
      return;
    }
    const rects = hoverRects();
    if (!inRect(rects.keep, x, y, HOVER_MARGIN)) {
      // 彻底离开：重新武装，下一次进来才允许探出。
      // Fully gone: re-arm, so the next entry is allowed to peek.
      hoverArmed = true;
      if (hoverMover) {
        hoverMover = false;
        updatePeek();
      }
      return;
    }
    if (!hoverArmed) return;
    const next = hoverMover || inRect(rects.enter, x, y, HOVER_MARGIN);
    if (next === hoverMover) return;
    hoverMover = next;
    updatePeek();
  }

  function updatePeek() {
    const next = Boolean(hoverMover);
    if (next === peeking) return;
    peeking = next;
    applyPlace();
  }

  // 点击面板以外的任何地方，展开的卡片收回成胶囊。
  // 捕获阶段挂在 document 上：页面自己的 stopPropagation 拦不住它；面板与 toast 各在自己的
  // shadow host 里，用 composedPath 认出"这一下点在内部"，不算点到外面。
  // Clicking anywhere outside folds the open card back into the pill. The listener is on the
  // capture phase of document, so page code that stops propagation cannot swallow it; the panel
  // and the toast each live in their own shadow host, and composedPath is what says "this click
  // landed inside them".
  function foldOnOutsidePointerDown(event) {
    if (collapsed || dragSession || !isTop) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const path = event.composedPath();
    if (path.includes(panelHost) || (toastHost && path.includes(toastHost))) return;
    setPanelCollapsed(true);
  }

  function stopDrag() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    if (panel) panel.classList.remove('moving');
    if (panelLauncher) panelLauncher.classList.remove('moving');
    dragSession = null;
  }

  function onDragMove(event) {
    if (!dragSession) return;
    const box = placementBox();
    const left = Math.round(event.clientX - dragSession.offsetX);
    const top = Math.round(event.clientY - dragSession.offsetY);
    if (!dragMoved) {
      const moved = Math.abs(left - dragSession.originLeft) > 3 || Math.abs(top - dragSession.originTop) > 3;
      if (!moved) return;
      // 只有真的移动才进入拖动：点一下不应改变贴边或位置。
      // A drag only starts once the pointer really moved; a plain click must not place or dock.
      dragMoved = true;
      // 用户把它挪走了：收起时不该再吸回老边缘。
      // The user moved it, so folding must not snap it back to the old edge.
      dockResume = '';
      place = { left: place.left, top: place.top, dock: '' };
      peeking = true;
      // 拖动跟手：位置的补间动画只留给松手吸附，否则卡片会拖在后面。
      // Follow the pointer: the position transition is only for the snap, never mid-drag.
      if (panelHost) panelHost.style.transition = 'none';
      dragSession.mover?.classList.add('moving');
    }
    place = { left: clampNumber(left, 0, viewportWidth() - box.width), top: clampNumber(top, 0, viewportHeight() - box.height), dock: '' };
    applyPlace();
  }

  function onDragEnd(event) {
    if (!dragSession) return;
    const mover = dragSession.mover;
    stopDrag();
    // 拖动时强制探出过，松手先把探出收回，否则贴边动画不会开始。
    // A drag forces the peeked state; drop it first, or the park animation never starts.
    hoverMover = false;
    updatePeek();
    if (panelHost) panelHost.style.transition = '';
    if (dragMoved) {
      const side = dockSideFor(mover);
      place = { left: place.left, top: place.top, dock: side };
      savePlace();
      // 松手点通常还落在刚贴边的探出区里：先解除悬停，指针退出这块区域再回来才允许探出，
      // 否则"拖到边上收起"刚做完就被自己弹回屏内。
      // The release point is still inside the zone the dock just created, so hover stays disarmed
      // until the pointer leaves that zone and returns — otherwise the snap we just made would
      // peek itself back out on the spot.
      hoverArmed = !side;
      // 卡片拖到边上就收起成胶囊：贴边的只有胶囊，展开的只有卡片。
      // setPanelCollapsed 会顺带重渲染并重新定位，所以只有不需要收起时才手动 applyPlace。
      // Releasing the card on an edge collapses it into the pill: only the pill docks, only the
      // card expands. Collapsing re-renders and repositions, so the manual pass is the else branch.
      if (side && !collapsed) setPanelCollapsed(true);
      else applyPlace();
    }
    // 松手后浏览器仍会派发 click，用一个短窗口把它与拖动区分开。
    // The browser still fires click after pointerup; a short window separates click from drag.
    setTimeout(() => { dragMoved = false; }, 300);
  }

  function startDrag(event, mover, blockDefault) {
    if (!isTop || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (!Number.isFinite(place.left) || !Number.isFinite(place.top)) applyPlace();
    // 标题栏可以放心拦默认行为，避免拖动时选中页面文字；
    // 胶囊本身是按钮，拦了就把它的 click 一起吞掉，所以只能不拦。
    // Cancelling pointerdown stops text selection while dragging the title bar, but the pill is
    // a button whose click would be swallowed too — so only the title bar blocks the default.
    if (blockDefault) event.preventDefault();
    dragMoved = false;
    dragSession = {
      offsetX: event.clientX - place.left,
      offsetY: event.clientY - place.top,
      originLeft: place.left,
      originTop: place.top,
      mover
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  }

  function bindPanelPlacement(shadow) {
    const head = shadow.querySelector('.head');
    // 标题栏里的按钮（最小化）自己处理点击，不参与拖动。
    // Buttons inside the title bar keep their own click and do not start a drag.
    head?.addEventListener('pointerdown', (event) => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      startDrag(event, panel, true);
    });
    panelLauncher?.addEventListener('pointerdown', (event) => startDrag(event, panelLauncher, false));
    // 探出改由指针坐标对静态区域求命中，不再听胶囊自己的 pointerenter/pointerleave：
    // 那块区域会随胶囊滑动而滑动，命中结果跟着翻转，贴边处就成了无限弹出/收起。
    // window pointermove 是被动监听，页面照常处理自己的事件。
    // The peek decision is now a hit test of the pointer against a static zone, instead of the
    // pill's own pointerenter/pointerleave: that zone travels with the pill, so the hit test
    // flipped every time it moved — the endless peek/park loop at the edge. Passive listener.
    window.addEventListener('pointermove', (event) => {
      setHoverFromPointer(event.clientX, event.clientY);
    }, { passive: true });
    // 指针离开文档（移出窗口）等同于离开区域：收回探出并重新武装。
    // Leaving the document counts as leaving the zone: park and re-arm.
    document.addEventListener('pointerleave', () => {
      hoverArmed = true;
      if (hoverMover) {
        hoverMover = false;
        updatePeek();
      }
    });
    document.addEventListener('pointerdown', foldOnOutsidePointerDown, true);
    window.addEventListener('resize', () => applyPlace());
    void loadPlace().then((stored) => {
      if (stored) place = { left: stored.left, top: stored.top, dock: stored.dock };
      applyPlace();
    });
  }

  // 收起状态交给后台保存，使 popup 的开关与面板互锁。
  // 收起时如果这次展开是从某条边上点开来的（dockResume），就吸回那条边：否则胶囊会飘在
  // 脱离贴边时的位置上，用户会觉得"贴边被点没了"。
  // Persist the collapsed state in the worker so the popup switch stays in sync. Folding also
  // re-docks to the edge the card was opened from (dockResume) — otherwise the pill stays where
  // the release left it, and the docking the user made looks like it was lost.
  function setPanelCollapsed(value) {
    collapsed = Boolean(value);
    renderPanel();
    if (collapsed && !place.dock && dockResume) {
      place = { left: place.left, top: place.top, dock: dockResume };
      dockResume = '';
      // 刚吸回去就先解除悬停，等指针离开区域再回来才探出——否则停在边上就立刻弹出。
      // Disarm the fresh park, or a pointer resting on the edge would peek it straight back out.
      hoverArmed = false;
      applyPlace();
      savePlace();
    } else if (collapsed) {
      dockResume = '';
    }
    void sendMessage({ type: MSG.PANEL_STATE, open: !collapsed });
  }

  function renderPanel() {
    if (!isTop) return;
    const hasMedia = Boolean(
      stateReady
      && media.size
      && state.settings.captureEnabled
      && state.settings.showMediaPanel
      && !state.siteBlocked
    );
    if (!hasMedia) {
      if (panelHost) panelHost.style.display = 'none';
      return;
    }
    ensurePanel();
    if (!panelHost || !panelList) return;
    panelHost.style.display = 'block';

    // 展开时只有卡片，收起时只有胶囊；胶囊用 visibility 让位，尺寸与位置仍然是定位基准。
    // Only the card when expanded, only the pill when collapsed; the pill steps aside with
    // visibility, so its size and position keep serving as the reference.
    if (panel) panel.style.display = collapsed ? 'none' : 'flex';
    if (panelLauncher) {
      panelLauncher.style.display = 'inline-flex';
      panelLauncher.style.visibility = collapsed ? 'visible' : 'hidden';
      if (launcherCount) launcherCount.textContent = String(media.size);
    }
    // 卡片尺寸可能刚变化，位置要在显示状态确定后再夹一次。
    // The visible box may just have changed, so clamp the position after the toggles.
    applyPlace();
    if (collapsed) return;

    const items = [...media.values()].slice(-30).reverse();
    panelCount.textContent = String(items.length);
    panelList.textContent = '';

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'item';
      row.setAttribute('role', 'listitem');

      const thumb = document.createElement('span');
      thumb.className = `thumb ${item.kind === 'audio' ? 'audio' : ''}`;
      thumb.innerHTML = item.kind === 'audio'
        ? '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4V5zm2 2v10h12V7H6zm2 2 4 3 4-3v6H8V9z"/></svg>';

      const info = document.createElement('span');
      info.className = 'info';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.label || filenameOf(item.url) || t('mediaFile', 'Media file');
      name.title = item.url;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const host = hostnameOf(item.url);
      meta.textContent = [item.ext, host].filter(Boolean).join(' · ');
      info.append(name, meta);

      const button = document.createElement('button');
      button.className = 'get';
      button.type = 'button';
      button.title = t('downloadWithNdm', 'Download with NDM');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 4h2v9.2l3.1-3.1 1.4 1.4-5.5 5.5-5.5-5.5 1.4-1.4 3.1 3.1V4zM5 19h14v2H5v-2z"/></svg>';
      button.addEventListener('click', () => {
        void downloadMedia(item, button);
      });

      row.append(thumb, info, button);
      panelList.appendChild(row);
    }

    const connected = Boolean(state.ndm?.connected);
    const dot = panel.querySelector('.dot');
    dot.className = `dot${state.siteBlocked ? ' blocked' : connected ? '' : ' off'}`;
    panelFooter.textContent = state.siteBlocked
      ? t('siteBlockedShort', 'Blocked on this site')
      : connected
        ? t('ndmConnectedShort', 'NDM connected')
        : t('ndmOfflineShort', 'NDM not connected');
  }

  async function downloadMedia(item, button) {
    button.disabled = true;
    const response = await sendMessage({
      type: MSG.DOWNLOAD_URL,
      url: item.url,
      pageUrl: item.frameUrl || (isTop ? location.href : ''),
      title: item.label,
      kind: item.kind,
      size: item.size || 0
    });
    if (response?.ok) {
      showToast(t('sentToNdm', 'Sent to NDM'));
    } else if (response?.error === 'site-blocked') {
      showToast(t('siteBlockedShort', 'Blocked on this site'));
    } else {
      showToast(t('ndmOfflineShort', 'NDM not connected'));
    }
    setTimeout(() => {
      button.disabled = false;
    }, 1200);
  }

  function hostnameOf(value) {
    try {
      return new URL(value).hostname;
    } catch {
      return '';
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Toast                                                                    */
  /* ------------------------------------------------------------------------ */

  function showToast(text) {
    if (!isTop || !text) return;
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'ndm-toast-host';
      toastHost.style.cssText = 'all: initial; position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 2147483647;';
      const shadow = toastHost.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          .toast {
            display: flex; align-items: center; gap: 8px;
            max-width: 360px; padding: 9px 13px;
            color: #e8eaed; background: #202124;
            border: 1px solid rgba(255,255,255,.12); border-radius: 10px;
            box-shadow: 0 8px 24px rgba(0,0,0,.32);
            font: 12.5px/1.35 "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            animation: ndm-toast-in .16s ease-out;
          }
          @media (prefers-color-scheme: dark) { .toast { background: #3c4043; } }
          .dot { width: 7px; height: 7px; border-radius: 50%; background: #81c995; flex: none; }
          @keyframes ndm-toast-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        </style>
        <div class="toast" role="status"><span class="dot"></span><span class="text"></span></div>
      `;
      adoptShadowStyles(shadow);
      (document.body || document.documentElement).appendChild(toastHost);
    }
    toastHost.style.display = 'block';
    const textNode = toastHost.shadowRoot.querySelector('.text');
    if (textNode) textNode.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastHost) toastHost.style.display = 'none';
    }, 1800);
  }

  // 优先使用构造样式表，避开严格页面 CSP / Prefer constructed sheets under strict page CSP.
  function adoptShadowStyles(shadow) {
    const style = shadow.querySelector('style');
    if (!style) return;
    try {
      if (typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in shadow)) return;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(style.textContent || '');
      shadow.adoptedStyleSheets = [sheet];
      style.remove();
    } catch {
      // 回退到 <style> / Fall back to the style element.
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------------ */
  /* State and lifecycle                                                      */
  /* ------------------------------------------------------------------------ */

  function stateKey() {
    return `${state.settings.captureEnabled}|${state.settings.showMediaPanel}|${state.siteBlocked}`;
  }

  function mergeMediaItems(items) {
    if (!isTop || !Array.isArray(items)) return false;
    stateReady = true;
    let added = false;
    for (const item of items) {
      if (!item || !/^https?:\/\//i.test(item.url || '') || media.has(item.url)) continue;
      media.set(item.url, {
        url: item.url,
        kind: item.kind === 'audio' ? 'audio' : item.kind === 'video' || item.kind === 'media' ? item.kind : 'media',
        label: item.label || filenameOf(item.url),
        ext: item.ext || extensionOf(item.url),
        size: Math.max(0, Number(item.size) || 0),
        frameUrl: item.frameUrl || location.href
      });
      added = true;
    }
    if (media.size > 30) {
      while (media.size > 30) {
        const first = media.keys().next().value;
        if (!first) break;
        media.delete(first);
      }
    }
    if (added) {
      renderPanel();
    }
    return added;
  }

  function applyState(payload) {
    if (!payload) return;
    const wasReady = stateReady;
    stateReady = true;
    const before = stateKey();
    if (payload.settings) Object.assign(state.settings, payload.settings);
    if (payload.ndm) state.ndm = payload.ndm;
    if (typeof payload.siteBlocked === 'boolean') state.siteBlocked = payload.siteBlocked;
    // 面板展开状态以后台为准，popup 开关与页面按钮因此保持一致。
    // The worker owns the panel state, keeping the popup switch and the in-page controls in sync.
    if (typeof payload.panelOpen === 'boolean') collapsed = !payload.panelOpen;
    const changed = before !== stateKey();
    if (Array.isArray(payload.media) && payload.media.length) {
      mergeMediaItems(payload.media);
    }

    if (!state.settings.captureEnabled || !state.settings.showMediaPanel || state.siteBlocked) {
      if (panelHost) panelHost.style.display = 'none';
    } else if (changed || !wasReady) {
      scheduleScan(250);
    }
    if (panel) renderPanel();
  }

  function clearLocalMedia() {
    media.clear();
    bilibiliParsed = false;
    if (panelList) panelList.textContent = '';
    if (panelHost) panelHost.style.display = 'none';
    if (panelCount) panelCount.textContent = '0';
  }

  function onLocationChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    clearLocalMedia();
    void sendMessage({
      type: MSG.PAGE_READY,
      pageUrl: isTop ? location.href : '',
      title: document.title
    });
    scheduleScan(700);
  }

  function onReady() {
    void sendMessage({
      type: MSG.GET_STATE,
      pageUrl: isTop ? location.href : '',
      title: document.title
    }).then((payload) => {
      applyState(payload);
      if (isTop) {
        void sendMessage({
          type: MSG.PAGE_READY,
          pageUrl: location.href,
          title: document.title
        });
      }
      if (stateReady) scheduleScan(500);
    });

    document.addEventListener('loadedmetadata', () => scheduleScan(350), true);
    document.addEventListener('durationchange', () => scheduleScan(600), true);
    document.addEventListener('play', () => scheduleScan(350), true);

    const root = document.documentElement;
    if (root && root !== observedRoot) {
      observedRoot = root;
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('video, audio, source, embed, object') || node.querySelector('video, audio, source, embed, object')) {
              scheduleScan(700);
              return;
            }
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    }

    if (isTop && !locationTimer) locationTimer = setInterval(onLocationChange, 1200);
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (message.type === MSG.STATE_CHANGED) {
      applyState(message);
      return;
    }
    if (message.type === MSG.MEDIA_ADD) {
      mergeMediaItems(message.items);
      return;
    }
    if (message.type === MSG.MEDIA_CLEAR) {
      clearLocalMedia();
      return;
    }
    if (message.type === MSG.SHOW_TOAST) {
      showToast(message.text);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
  } else {
    onReady();
  }

  // 页面卸载时停止计时器；BFCache 恢复后重新启动。
  // Stop timers on pagehide and restart them when restored from BFCache.
  window.addEventListener('pagehide', () => {
    clearInterval(locationTimer);
    locationTimer = null;
    clearTimeout(scanTimer);
  });
  window.addEventListener('pageshow', () => {
    if (isTop && !locationTimer) locationTimer = setInterval(onLocationChange, 1200);
    scheduleScan(300);
  });
})();
