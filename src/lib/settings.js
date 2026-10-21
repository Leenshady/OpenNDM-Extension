/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 设置与屏蔽列表的存储封装。
 * Storage helpers for settings and the site blocklist.
 */

import { DEFAULT_SETTINGS, NDM_PROTOCOL } from './constants.js';
import { mergeHosts } from './blocklist.js';

const SETTINGS_KEY = 'settings';
const BLOCKED_KEY = 'blockedSites';
const SESSION_KEY = 'sessionState';

/**
 * 读取并修正设置。
 * Read settings and clamp invalid values.
 */
export async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const port = Number(source.ndmPort);
  const minSize = Number(source.mediaMinSize);
  return {
    captureEnabled: source.captureEnabled !== false,
    captureMedia: source.captureMedia !== false,
    showMediaPanel: source.showMediaPanel !== false,
    autoCancelBrowserDownload: source.autoCancelBrowserDownload !== false,
    ndmPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : NDM_PROTOCOL.defaultPort,
    mediaMinSize: Number.isFinite(minSize) && minSize >= 0
      ? Math.min(512 * 1024 * 1024, Math.round(minSize))
      : DEFAULT_SETTINGS.mediaMinSize
  };
}

/**
 * 合并并保存设置。
 * Merge a patch into settings and persist it.
 */
export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * 读取屏蔽站点并去重。
 * Read the blocklist and dedupe it.
 */
export async function loadBlockedSites() {
  const stored = await chrome.storage.local.get(BLOCKED_KEY);
  return mergeHosts(stored[BLOCKED_KEY]);
}

export async function saveBlockedSites(hosts) {
  const next = mergeHosts(hosts);
  await chrome.storage.local.set({ [BLOCKED_KEY]: next });
  return next;
}

/**
 * 保存会话级状态（最近捕获、绕过时间）。
 * Persist session-only state such as recent captures and bypass timestamp.
 */
export async function loadSessionState() {
  try {
    const stored = await chrome.storage.session.get(SESSION_KEY);
    return stored[SESSION_KEY] && typeof stored[SESSION_KEY] === 'object'
      ? stored[SESSION_KEY]
      : {};
  } catch {
    return {};
  }
}

let sessionWrite = Promise.resolve();

// 串行写入，避免最近捕获与绕过时间互相覆盖。
// Serialize writes so recent captures and bypass timestamps cannot overwrite each other.
export function saveSessionState(patch) {
  sessionWrite = sessionWrite.then(async () => {
    try {
      const current = await loadSessionState();
      await chrome.storage.session.set({ [SESSION_KEY]: { ...current, ...(patch || {}) } });
    } catch {
      // 会话存储不可用时不影响主流程 / Session storage failures must not break capture.
    }
  });
  return sessionWrite;
}

export function onStorageChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[SETTINGS_KEY] || changes[BLOCKED_KEY])) callback(changes);
  });
}
