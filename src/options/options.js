/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 选项页：连接、捕获规则、文件类型、屏蔽站点与许可证。
 * Options page: connection, capture rules, file types, blocklist, and license.
 */
(() => {
  'use strict';

  const MSG = {
    GET_STATE: 'GET_STATE',
    SET_SETTINGS: 'SET_SETTINGS',
    SET_SITE_BLOCKED: 'SET_SITE_BLOCKED',
    REMOVE_BLOCKED_SITE: 'REMOVE_BLOCKED_SITE',
    TEST_CONNECTION: 'TEST_CONNECTION'
  };

  const DEFAULT_PATCH = {
    captureEnabled: true,
    captureMedia: true,
    showMediaPanel: true,
    autoCancelBrowserDownload: true,
    ndmPort: 10007,
    mediaMinSize: 512 * 1024
  };

  const TYPE_GROUPS = [
    {
      key: 'typeMedia',
      exts: ['MP4', 'M4V', 'MKV', 'WEBM', 'MOV', 'AVI', 'WMV', 'FLV', 'TS', 'M3U8', 'MP3', 'M4A', 'AAC', 'FLAC', 'WAV', 'OGG', 'OPUS']
    },
    {
      key: 'typeArchives',
      exts: ['ZIP', 'RAR', '7Z', 'TAR', 'GZ', 'BZ2', 'XZ', 'ISO', 'DMG', 'PKG', 'MSI', 'EXE', 'APK', 'JAR']
    },
    {
      key: 'typeDocuments',
      exts: ['PDF', 'DOC', 'DOCX', 'XLS', 'XLSX', 'PPT', 'PPTX', 'EPUB', 'MOBI', 'MSG', 'CSV', 'RTF']
    },
    {
      key: 'typeSubtitles',
      exts: ['SRT', 'VTT', 'ASS', 'SSA', 'DFXP', 'TTML']
    },
    {
      key: 'typeExplicit',
      explicit: true,
      exts: ['HTML', 'CSS', 'JS', 'JSON', 'XML', 'TXT', 'PNG', 'JPG', 'GIF', 'SVG', 'WEBP', 'WOFF2', 'WASM', 'BIN']
    }
  ];

  const state = {
    settings: { ...DEFAULT_PATCH },
    ndm: { connected: false, port: 10007, version: '' },
    blockedSites: [],
    version: ''
  };

  const $ = (id) => document.getElementById(id);
  let toastTimer = null;
  let typesRendered = false;

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
    document.title = `${t('extName', 'OpenNDM-Extension')} · ${t('popupSettings', 'Settings')}`;
    $('siteInput').placeholder = t('sitePlaceholder', 'example.com');
    $('licenseLink').href = chrome.runtime.getURL('LICENSE');
  }

  function render() {
    const { settings, ndm } = state;
    $('portInput').value = settings.ndmPort;
    $('captureEnabled').checked = Boolean(settings.captureEnabled);
    $('captureMedia').checked = Boolean(settings.captureMedia);
    $('showMediaPanel').checked = Boolean(settings.showMediaPanel);
    $('autoCancel').checked = Boolean(settings.autoCancelBrowserDownload);
    $('minSizeInput').value = (Number(settings.mediaMinSize) / (1024 * 1024)).toFixed(1);
    $('version').textContent = state.version ? `v${state.version}` : '';

    const connected = Boolean(ndm.connected);
    const dot = $('connDot');
    dot.className = 'dot';
    dot.classList.add(connected ? 'on' : 'error');
    $('connText').textContent = connected
      ? t('popupConnected', 'NDM connected')
      : t('popupDisconnected', 'NDM not connected');
    $('connVersion').textContent = connected && ndm.version ? `v${ndm.version}` : '';

    renderBlocked();
    if (!typesRendered) {
      renderTypes();
      typesRendered = true;
    }
  }

  // 生成支持类型标签 / Render supported-type chips.
  function renderTypes() {
    const container = $('typeGroups');
    container.textContent = '';
    for (const group of TYPE_GROUPS) {
      const wrapper = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'type-group-name';
      name.textContent = t(group.key, group.key);
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const ext of group.exts) {
        const chip = document.createElement('span');
        chip.className = `chip${group.explicit ? ' explicit' : ''}`;
        chip.textContent = ext;
        chips.appendChild(chip);
      }
      wrapper.append(name, chips);
      container.appendChild(wrapper);
    }
  }

  function renderBlocked() {
    const list = $('blockedList');
    list.textContent = '';
    const sites = Array.isArray(state.blockedSites) ? state.blockedSites : [];
    $('blockedEmpty').hidden = sites.length > 0;

    for (const host of sites) {
      const row = document.createElement('li');
      row.className = 'blocked-item';
      const name = document.createElement('span');
      name.className = 'blocked-host';
      name.textContent = host;
      name.title = host;

      const remove = document.createElement('button');
      remove.className = 'remove-site';
      remove.type = 'button';
      remove.title = t('remove', 'Remove');
      remove.setAttribute('aria-label', `${t('remove', 'Remove')} ${host}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4 6.4 5z"/></svg>';
      remove.addEventListener('click', () => void removeSite(host));

      row.append(name, remove);
      list.appendChild(row);
    }
  }

  async function savePatch(patch, successMessage = true) {
    const response = await send({ type: MSG.SET_SETTINGS, patch });
    if (!response?.ok) {
      showToast(t('saveFailed', 'Could not save settings.'));
      return false;
    }
    state.settings = response.settings;
    render();
    if (successMessage) showToast(t('settingsSaved', 'Settings saved.'));
    return true;
  }

  async function testConnection() {
    const button = $('testBtn');
    button.disabled = true;
    button.textContent = t('testingConnection', 'Testing…');
    const response = await send({ type: MSG.TEST_CONNECTION });
    if (response?.ndm) state.ndm = response.ndm;
    render();
    showToast(state.ndm.connected
      ? t('testSuccess', 'Connected to NDM.')
      : t('testFailed', 'NDM is not reachable. Start the app and try again.'));
    button.disabled = false;
    button.textContent = t('testConnection', 'Test connection');
  }

  async function addSite() {
    const input = $('siteInput');
    const raw = input.value.trim();
    if (!raw) return;
    const response = await send({ type: MSG.SET_SITE_BLOCKED, host: raw, blocked: true });
    if (!response?.ok) {
      $('siteError').textContent = t('invalidSite', 'Enter a valid domain, for example example.com.');
      $('siteError').hidden = false;
      return;
    }
    $('siteError').hidden = true;
    input.value = '';
    state.blockedSites = response.blockedSites || state.blockedSites;
    renderBlocked();
    showToast(t('siteAdded', 'Site blocked.'));
  }

  async function removeSite(host) {
    const response = await send({ type: MSG.REMOVE_BLOCKED_SITE, host });
    if (response?.ok) {
      state.blockedSites = response.blockedSites || [];
      renderBlocked();
      showToast(t('siteRemoved', 'Site removed.'));
    }
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2400);
  }

  /* ------------------------------ events ---------------------------------- */

  $('portInput').addEventListener('change', async () => {
    const port = Number($('portInput').value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      $('portInput').value = state.settings.ndmPort;
      showToast(t('portInvalid', 'Use a port between 1 and 65535.'));
      return;
    }
    if (await savePatch({ ndmPort: port })) {
      setTimeout(() => void testConnection(), 250);
    }
  });

  $('testBtn').addEventListener('click', async () => {
    const port = Number($('portInput').value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== state.settings.ndmPort) {
      await savePatch({ ndmPort: port }, false);
    }
    await testConnection();
  });

  const bindSwitch = (id, key) => {
    $(id).addEventListener('change', async (event) => {
      const ok = await savePatch({ [key]: event.target.checked });
      if (!ok) event.target.checked = !event.target.checked;
    });
  };

  bindSwitch('captureEnabled', 'captureEnabled');
  bindSwitch('captureMedia', 'captureMedia');
  bindSwitch('showMediaPanel', 'showMediaPanel');
  bindSwitch('autoCancel', 'autoCancelBrowserDownload');

  $('minSizeInput').addEventListener('change', async () => {
    let mb = Number($('minSizeInput').value);
    if (!Number.isFinite(mb) || mb < 0) {
      $('minSizeInput').value = (state.settings.mediaMinSize / (1024 * 1024)).toFixed(1);
      showToast(t('sizeInvalid', 'Enter a size of 0 MB or more.'));
      return;
    }
    mb = Math.min(512, mb);
    await savePatch({ mediaMinSize: Math.round(mb * 1024 * 1024) });
  });

  $('addSiteBtn').addEventListener('click', () => void addSite());
  $('siteInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void addSite();
  });
  $('siteInput').addEventListener('input', () => {
    $('siteError').hidden = true;
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm(t('resetConfirm', 'Reset all settings to their defaults?'))) return;
    await savePatch(DEFAULT_PATCH);
    setTimeout(() => void testConnection(), 300);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    if (changes.settings?.newValue) {
      state.settings = { ...state.settings, ...changes.settings.newValue };
      changed = true;
    }
    if (changes.blockedSites?.newValue) {
      state.blockedSites = changes.blockedSites.newValue;
      changed = true;
    }
    if (changed) render();
  });

  async function load() {
    applyI18n();
    const response = await send({ type: MSG.GET_STATE });
    if (response?.ok) {
      state.settings = response.settings || state.settings;
      state.ndm = response.ndm || state.ndm;
      state.blockedSites = response.blockedSites || [];
      state.version = response.version || '';
    }
    render();
  }

  void load();
})();
