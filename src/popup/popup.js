/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 弹窗逻辑：状态展示、站点开关与最近捕获。
 * Popup logic: status, site toggle, and recent captures.
 */
(() => {
  'use strict';

  const MSG = {
    GET_STATE: 'GET_STATE',
    SET_SETTINGS: 'SET_SETTINGS',
    SET_SITE_BLOCKED: 'SET_SITE_BLOCKED',
    TEST_CONNECTION: 'TEST_CONNECTION',
    CLEAR_RECENT: 'CLEAR_RECENT'
  };

  const state = {
    settings: { captureEnabled: true, showMediaPanel: true, ndmPort: 10007 },
    ndm: { connected: false, port: 10007, version: '' },
    blockedSites: [],
    recent: [],
    siteBlocked: false,
    siteSupported: false,
    host: '',
    version: ''
  };

  const $ = (id) => document.getElementById(id);

  function t(key, fallback) {
    try {
      return chrome.i18n.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function send(message) {
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

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      const value = t(element.dataset.i18n, element.textContent);
      if (value) element.textContent = value;
    });
    const language = chrome.i18n.getUILanguage();
    document.documentElement.lang = language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
    document.title = t('extName', 'OpenNDM-Extension');
    $('captureToggle').setAttribute('aria-label', t('popupCaptureTitle', 'Capture downloads'));
    $('siteToggle').setAttribute('aria-label', t('popupSiteBlockTitle', 'Block NDM on this site'));
    $('mediaToggle').setAttribute('aria-label', t('popupMediaPanel', 'Media panel'));
    $('settingsBtn').title = t('popupSettings', 'Settings');
    $('settingsBtn').setAttribute('aria-label', t('popupSettings', 'Settings'));
  }

  function render() {
    const { settings, ndm } = state;
    const connected = Boolean(ndm.connected);

    $('captureToggle').checked = Boolean(settings.captureEnabled);
    $('mediaToggle').checked = Boolean(settings.showMediaPanel);
    $('siteToggle').checked = Boolean(state.siteBlocked);
    $('siteToggle').disabled = !state.siteSupported;

    const dot = $('statusDot');
    dot.className = 'dot';
    if (!settings.captureEnabled) {
      dot.classList.add('off');
      $('statusText').textContent = t('captureOff', 'Capture off');
    } else if (connected) {
      dot.classList.add('on');
      $('statusText').textContent = t('ndmConnected', 'NDM connected');
    } else {
      dot.classList.add('error');
      $('statusText').textContent = t('ndmDisconnected', 'NDM not connected');
    }

    const version = ndm.version ? ` · v${ndm.version}` : '';
    $('connDetail').textContent = `127.0.0.1:${ndm.port || settings.ndmPort || 10007}${version}`;
    $('siteHost').textContent = state.siteSupported
      ? (state.host || '—')
      : t('popupSiteUnavailable', 'Not available on this page');

    const siteStatus = $('siteStatus');
    siteStatus.textContent = state.siteSupported
      ? (state.siteBlocked ? t('popupBlocked', 'Blocked') : t('popupAllowed', 'Allowed'))
      : '';
    siteStatus.className = `site-state${state.siteBlocked ? ' blocked' : ''}`;

    $('siteToggle').title = state.siteSupported
      ? (state.siteBlocked ? t('popupUnblockSite', 'Unblock downloads on this site') : t('popupSiteBlockTitle', 'Block NDM on this site'))
      : t('popupSiteUnavailable', 'Not available on this page');
    $('version').textContent = state.version ? `v${state.version}` : '';
    $('clearBtn').disabled = state.recent.length === 0;

    renderRecent();
  }

  function renderRecent() {
    const list = $('recentList');
    const empty = $('emptyRecent');
    list.textContent = '';
    const items = state.recent.slice(0, 6);
    empty.hidden = items.length > 0;

    for (const item of items) {
      const row = document.createElement('li');
      row.className = 'recent-item';

      const icon = document.createElement('span');
      icon.className = `recent-icon ${item.kind === 'media' || item.kind === 'hls' ? 'media' : 'normal'}`;
      icon.innerHTML = item.kind === 'media' || item.kind === 'hls'
        ? '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4V5zm2 2v10h12V7H6zm2 2 4 3 4-3v6H8V9z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M11 4h2v9.2l3.1-3.1 1.4 1.4-5.5 5.5-5.5-5.5 1.4-1.4 3.1 3.1V4zM5 19h14v2H5v-2z"/></svg>';

      const copy = document.createElement('span');
      copy.className = 'recent-copy';
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = item.filename || item.host || item.url || 'download';
      name.title = item.url || '';
      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      meta.textContent = [
        kindLabel(item.kind),
        formatBytes(item.size),
        item.time ? new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      ].filter(Boolean).join(' · ');

      copy.append(name, meta);
      row.append(icon, copy);
      list.appendChild(row);
    }
  }

  function kindLabel(kind) {
    if (kind === 'hls') return t('fileTypeHls', 'HLS');
    if (kind === 'media') return t('fileTypeMedia', 'Media');
    return t('fileTypeFile', 'File');
  }

  function formatBytes(bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
    return `${(size / 1024 ** 3).toFixed(2)} GB`;
  }

  let toastTimer = null;

  function showToast(message) {
    const toast = $('popupToast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  }

  async function load() {
    applyI18n();
    let tab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs[0] || null;
    } catch {
      tab = null;
    }

    const response = await send({
      type: MSG.GET_STATE,
      tabId: tab?.id,
      pageUrl: tab?.url || '',
      title: tab?.title || ''
    });
    if (response?.ok) Object.assign(state, response);
    render();
  }

  $('captureToggle').addEventListener('change', async (event) => {
    const checked = event.target.checked;
    const response = await send({ type: MSG.SET_SETTINGS, patch: { captureEnabled: checked } });
    if (response?.ok) {
      state.settings = response.settings;
    } else {
      event.target.checked = !checked;
    }
    render();
  });

  $('mediaToggle').addEventListener('change', async (event) => {
    const checked = event.target.checked;
    const response = await send({ type: MSG.SET_SETTINGS, patch: { showMediaPanel: checked } });
    if (response?.ok) {
      state.settings = response.settings;
    } else {
      event.target.checked = !checked;
    }
    render();
  });

  $('siteToggle').addEventListener('change', async (event) => {
    if (!state.siteSupported || !state.host) {
      event.target.checked = false;
      showToast(t('popupSiteUnavailable', 'Not available on this page'));
      return;
    }
    const blocked = event.target.checked;
    const response = await send({ type: MSG.SET_SITE_BLOCKED, host: state.host, blocked });
    if (response?.ok) {
      state.siteBlocked = blocked;
      state.blockedSites = response.blockedSites || state.blockedSites;
      showToast(blocked
        ? t('siteBlockedToast', 'NDM disabled for this site')
        : t('siteUnblockedToast', 'NDM enabled for this site'));
    } else {
      event.target.checked = !blocked;
      showToast(t('popupSiteError', 'Could not update the blocklist.'));
    }
    render();
  });

  $('testBtn').addEventListener('click', async () => {
    const button = $('testBtn');
    button.disabled = true;
    button.textContent = t('popupTesting', 'Testing…');
    const response = await send({ type: MSG.TEST_CONNECTION });
    if (response?.ndm) state.ndm = response.ndm;
    render();
    button.disabled = false;
    button.textContent = t('popupTest', 'Test');
  });

  $('clearBtn').addEventListener('click', async () => {
    await send({ type: MSG.CLEAR_RECENT });
    state.recent = [];
    render();
  });

  $('optionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $('settingsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  void load();
})();
