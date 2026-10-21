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
    SHOW_TOAST: 'SHOW_TOAST'
  };

  const DOWNLOAD_HINT_RE = /\.(?:zip|rar|7z|tar|gz|bz2|xz|iso|dmg|exe|msi|apk|pdf|docx?|xlsx?|pptx?|epub|mp4|m4v|mkv|webm|mov|avi|mp3|m4a|flac|wav|ogg|opus|ts|m3u8|srt|vtt)(?:[?#]|$)/i;
  const MEDIA_HINT_RE = /\.(?:mp4|m4v|mkv|webm|mov|avi|wmv|flv|ts|m3u8|mp3|m4a|aac|flac|wav|ogg|oga|opus|m4b)(?:[?#]|$)/i;
  const MEDIA_HOST_SKIP_RE = /(?:^|\.)(?:doubleclick|googlesyndication|adservice|adserver)\./i;

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
  let dismissed = false;
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
    if (anchor.hasAttribute('download')) return true;
    return DOWNLOAD_HINT_RE.test(anchor.href || '');
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
      dismissed = false;
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
    panelHost.style.cssText = 'all: initial; position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;';
    const shadow = panelHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .panel {
          width: 326px;
          max-height: 430px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: #202124;
          background: #ffffff;
          border: 1px solid #dadce0;
          border-radius: 14px;
          box-shadow: 0 12px 36px rgba(32, 33, 36, .22), 0 2px 6px rgba(32, 33, 36, .12);
          font: 13px/1.4 "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          animation: ndm-in .18s ease-out;
        }
        @keyframes ndm-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
        .head { display: flex; align-items: center; gap: 9px; padding: 11px 10px 10px 13px; border-bottom: 1px solid #e8eaed; }
        .brand { width: 26px; height: 26px; border-radius: 8px; background: #1e8e3e; display: grid; place-items: center; flex: none; }
        .brand svg { width: 15px; height: 15px; display: block; fill: #fff; }
        .titles { min-width: 0; flex: 1; }
        .title { display: block; font-weight: 600; font-size: 13px; letter-spacing: .1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sub { display: block; margin-top: 1px; color: #5f6368; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #e8f0fe; color: #1967d2; font-size: 11px; font-weight: 600; display: grid; place-items: center; box-sizing: border-box; }
        .icon-btn { width: 28px; height: 28px; border: 0; border-radius: 50%; background: transparent; color: #5f6368; display: grid; place-items: center; cursor: pointer; padding: 0; }
        .icon-btn:hover { background: #f1f3f4; color: #202124; }
        .icon-btn:focus-visible { outline: 2px solid #1a73e8; outline-offset: 1px; }
        .icon-btn svg { width: 16px; height: 16px; fill: currentColor; }
        .list { overflow: auto; padding: 6px; }
        .list::-webkit-scrollbar { width: 8px; }
        .list::-webkit-scrollbar-thumb { background: #dadce0; border-radius: 4px; }
        .item { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 9px; }
        .item:hover { background: #f8f9fa; }
        .thumb { width: 34px; height: 34px; border-radius: 8px; background: #e8f0fe; color: #1967d2; display: grid; place-items: center; flex: none; }
        .thumb.audio { background: #e6f4ea; color: #137333; }
        .thumb svg { width: 17px; height: 17px; fill: currentColor; }
        .info { min-width: 0; flex: 1; }
        .name { display: block; color: #202124; font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .meta { display: block; margin-top: 2px; color: #5f6368; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .get { width: 30px; height: 30px; flex: none; border: 0; border-radius: 8px; background: #1a73e8; color: #fff; display: grid; place-items: center; cursor: pointer; padding: 0; }
        .get:hover { background: #1765cc; }
        .get:disabled { opacity: .62; cursor: default; }
        .get:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }
        .get svg { width: 15px; height: 15px; fill: currentColor; }
        .foot { padding: 8px 13px 10px; border-top: 1px solid #e8eaed; color: #5f6368; font-size: 11px; display: flex; align-items: center; gap: 6px; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #1e8e3e; flex: none; }
        .dot.off { background: #f9ab00; }
        .dot.blocked { background: #d93025; }
        @media (prefers-color-scheme: dark) {
          .panel { color: #e8eaed; background: #292a2d; border-color: #3c4043; box-shadow: 0 14px 40px rgba(0,0,0,.55); }
          .head, .foot { border-color: #3c4043; }
          .sub, .meta, .foot, .icon-btn { color: #9aa0a6; }
          .title, .name { color: #e8eaed; }
          .item:hover, .icon-btn:hover { background: #3c4043; color: #e8eaed; }
          .count { background: #1a3a63; color: #8ab4f8; }
          .thumb { background: #1a3a63; color: #8ab4f8; }
          .thumb.audio { background: #173a28; color: #81c995; }
        }
      </style>
      <section class="panel" role="dialog" aria-label="${escapeHtml(t('mediaPanelTitle', 'Page media'))}">
        <header class="head">
          <span class="brand" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4L10 13.2V3h2zm-8 16h16v2H4v-2z"/></svg>
          </span>
          <div class="titles">
            <span class="title">${escapeHtml(t('mediaPanelTitle', 'Page media'))}</span>
            <span class="sub">${escapeHtml(t('mediaPanelSubtitle', 'Download with Neat Download Manager'))}</span>
          </div>
          <span class="count">0</span>
          <button class="icon-btn close" type="button" title="${escapeHtml(t('close', 'Close'))}" aria-label="${escapeHtml(t('close', 'Close'))}">
            <svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4 6.4 5z"/></svg>
          </button>
        </header>
        <div class="list" role="list"></div>
        <footer class="foot"><span class="dot"></span><span class="status"></span></footer>
      </section>
    `;
    adoptShadowStyles(shadow);
    (document.body || document.documentElement).appendChild(panelHost);
    panel = shadow.querySelector('.panel');
    panelList = shadow.querySelector('.list');
    panelCount = shadow.querySelector('.count');
    panelFooter = shadow.querySelector('.status');
    shadow.querySelector('.close').addEventListener('click', () => {
      dismissed = true;
      renderPanel();
    });
  }

  function renderPanel() {
    if (!isTop) return;
    const visible = Boolean(
      stateReady
      && media.size
      && state.settings.captureEnabled
      && state.settings.showMediaPanel
      && !state.siteBlocked
      && !dismissed
    );
    if (!visible) {
      if (panelHost) panelHost.style.display = 'none';
      return;
    }
    ensurePanel();
    if (!panelHost || !panelList) return;
    panelHost.style.display = 'block';

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
      dismissed = false;
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
