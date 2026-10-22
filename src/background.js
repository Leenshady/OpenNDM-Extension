/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * MV3 Service Worker：捕获下载、聚合媒体、屏蔽站点并连接 NDM。
 * MV3 service worker: capture downloads, aggregate media, block sites, and talk to NDM.
 */

import {
  DEFAULT_SETTINGS,
  HLS_EXTENSIONS,
  HLS_MIMES,
  LIMITS,
  MEDIA_EXTENSIONS,
  MSG,
  NDM_PROTOCOL,
  NON_DOWNLOAD_MIMES,
  REQUEST_TYPES
} from './lib/constants.js';
import { decideCapture } from './lib/rules.js';
import {
  isHostBlocked,
  isRequestBlocked,
  mergeHosts,
  normalizeHost,
  removeHostRule
} from './lib/blocklist.js';
import {
  loadBlockedSites,
  loadSessionState,
  loadSettings,
  normalizeSettings,
  onStorageChanged,
  saveBlockedSites,
  saveSessionState,
  saveSettings
} from './lib/settings.js';
import { NdmClient } from './lib/ndm.js';
import {
  extensionFromMime,
  extensionOf,
  filenameFrom,
  formatBytes,
  getHeader,
  hostnameOf,
  isHttpUrl,
  normalizeMime,
  originOf,
  safeFilename,
  sanitizeHeaderValue,
  serializeRequestBody,
  stripHash
} from './lib/utils.js';

// 内存状态 / In-memory state.
const requestContexts = new Map();
const inflightCaptures = new Map();
const pendingCancel = new Map();
const recentSent = new Map();
const seenHeaderUrls = new Map();
const waitingFetches = new Map();
const mediaByTab = new Map();
// 面板默认最小化，只有显式展开过的标签页才会记录在此 / Tabs that expanded the panel.
const panelOpenTabs = new Set();
const tabInfo = new Map();

let settings = { ...DEFAULT_SETTINGS };
let blockedSites = [];
let recentCaptures = [];
let bypassUntil = 0;
let initialized = false;
let initPromise = null;
let broadcastTimer = null;
let requestCounter = 0;

const ndm = new NdmClient({
  port: NDM_PROTOCOL.defaultPort,
  onState: () => {
    updateBadge();
    scheduleBroadcast();
  },
  onPanelPreference: (enabled) => {
    // NDM 的面板偏好只作为提示，不覆盖用户设置。
    // NDM's panel preference is informational; it never overrides user settings.
    if (typeof enabled === 'boolean') {
      scheduleBroadcast();
    }
  },
  onWaiting: (payload) => {
    void handleNdmWaiting(payload);
  }
});

/**
 * 初始化设置、屏蔽列表、会话状态与 NDM 连接。
 * Initialize settings, blocklist, session state, and the NDM connection.
 */
async function initialize() {
  if (initialized) return;
  settings = await loadSettings();
  blockedSites = await loadBlockedSites();
  const session = await loadSessionState();
  if (Array.isArray(session.recentCaptures)) {
    recentCaptures = session.recentCaptures.slice(0, LIMITS.recentCaptures);
  }
  if (Number(session.bypassUntil) > Date.now()) {
    bypassUntil = Number(session.bypassUntil);
  }

  ndm.setPort(settings.ndmPort);
  ndm.ensureConnected();
  initialized = true;

  await ensureMenus();
  await ensureKeepAliveAlarm();
  updateBadge();
  scheduleBroadcast();
}

function ensureInit() {
  if (!initPromise) {
    initPromise = initialize().catch((error) => {
      console.error('[OpenNDM] init failed', error);
      initialized = true;
    });
  }
  return initPromise;
}

/* -------------------------------------------------------------------------- */
/* Badge, menus, and state broadcast                                          */
/* -------------------------------------------------------------------------- */

function t(key, fallback = '') {
  return chrome.i18n.getMessage(key) || fallback;
}

/**
 * 更新工具栏角标：OFF / ! / 空。
 * Update the toolbar badge: OFF, !, or empty.
 */
function updateBadge() {
  const state = ndm.getState();
  let text = '';
  let color = '#1e8e3e';
  let title = t('actionTitle', 'OpenNDM-Extension');

  if (!settings.captureEnabled) {
    text = 'OFF';
    color = '#5f6368';
    title = `${t('extName', 'OpenNDM-Extension')} · ${t('captureOff', 'Capture off')}`;
  } else if (!state.connected) {
    text = '!';
    color = '#f9ab00';
    title = `${t('extName', 'OpenNDM-Extension')} · ${t('ndmDisconnected', 'NDM not connected')}`;
  }

  try {
    chrome.action.setBadgeText({ text }, () => void chrome.runtime.lastError);
    chrome.action.setBadgeBackgroundColor({ color }, () => void chrome.runtime.lastError);
    chrome.action.setTitle({ title }, () => void chrome.runtime.lastError);
  } catch {
    // 忽略工具栏 API 的瞬时错误 / Ignore transient action API errors.
  }
}

function scheduleBroadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    void broadcastState();
  }, 180);
}

/**
 * 向所有标签页的顶层内容脚本推送状态。
 * Push current state to top-frame content scripts in every tab.
 */
async function broadcastState() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  const state = ndm.getState();
  for (const tab of tabs) {
    if (!tab.id || !/^https?:\/\//i.test(tab.url || '')) continue;
    const siteBlocked = isHostBlocked(hostnameOf(tab.url), blockedSites);
    await sendTabMessage(tab.id, {
      type: MSG.STATE_CHANGED,
      settings,
      ndm: state,
      blockedSites,
      siteBlocked,
      panelOpen: panelOpenTabs.has(tab.id),
      pageUrl: tab.url || ''
    });
  }
}

function sendTabMessage(tabId, message, options) {
  return new Promise((resolve) => {
    try {
      const callback = (response) => {
        void chrome.runtime.lastError;
        resolve(response ?? null);
      };
      if (options) chrome.tabs.sendMessage(tabId, message, options, callback);
      else chrome.tabs.sendMessage(tabId, message, callback);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 创建右键菜单，保持与浏览器原生一致的文案。
 * Create context menus with native-style labels.
 */
async function ensureMenus() {
  await new Promise((resolve) => {
    try {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });

  const create = (properties) => {
    try {
      chrome.contextMenus.create(properties, () => void chrome.runtime.lastError);
    } catch {
      // 菜单重复创建时忽略 / Ignore duplicate menu creation.
    }
  };

  create({
    id: 'ndm-download-link',
    title: t('contextDownload', 'Download with NDM'),
    contexts: ['link', 'image', 'video', 'audio']
  });
  create({
    id: 'ndm-block-site',
    title: t('contextBlock', 'Block downloads on this site'),
    contexts: ['page', 'frame']
  });

  await updateMenuForActiveTab();
}

async function ensureKeepAliveAlarm() {
  try {
    await chrome.alarms.create('ndm-keepalive', { periodInMinutes: 1 });
  } catch {
    // 闹钟不可用时依赖 WebSocket 活跃状态 / If alarms fail, WebSocket activity keeps the worker alive.
  }
}

async function updateMenuForActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]) updateMenuForTab(tabs[0]);
  } catch {
    // 忽略没有活动标签页的窗口 / Ignore windows without an active tab.
  }
}

function updateMenuForTab(tab) {
  if (!tab) return;
  const blocked = isHostBlocked(hostnameOf(tab.url), blockedSites);
  const title = blocked ? t('contextUnblock', 'Unblock downloads on this site') : t('contextBlock', 'Block downloads on this site');
  try {
    chrome.contextMenus.update('ndm-block-site', { title }, () => void chrome.runtime.lastError);
  } catch {
    // 菜单尚未创建时忽略 / Ignore when menus do not exist yet.
  }
}

/* -------------------------------------------------------------------------- */
/* Context menu and manual actions                                            */
/* -------------------------------------------------------------------------- */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ndm-download-link') {
    const url = info.linkUrl || info.srcUrl || info.pageUrl;
    if (!url) return;
    void manualDownload({
      url,
      pageUrl: info.pageUrl || tab?.url || '',
      title: tab?.title || '',
      tabId: tab?.id ?? -1,
      waitMs: 2200
    });
    return;
  }

  if (info.menuItemId === 'ndm-block-site' && tab?.url) {
    void toggleSiteBlocked(tab.url, tab.id);
  }
});

async function toggleSiteBlocked(rawUrl, tabId = -1) {
  const host = normalizeHost(rawUrl);
  if (!host) return { ok: false, error: 'invalid-host' };
  const wasBlocked = isHostBlocked(host, blockedSites);
  const next = wasBlocked
    ? removeHostRule(host, blockedSites)
    : mergeHosts(blockedSites, [host]);
  blockedSites = await saveBlockedSites(next);
  updateMenuForTab({ id: tabId, url: `https://${host}/` });
  scheduleBroadcast();

  if (tabId >= 0) {
    await sendTabMessage(tabId, {
      type: MSG.SHOW_TOAST,
      text: wasBlocked ? t('siteUnblockedToast', 'NDM enabled for this site') : t('siteBlockedToast', 'NDM disabled for this site')
    });
  }
  return { ok: true, host, blocked: !wasBlocked, blockedSites };
}

/**
 * 将明确的下载 URL 交给 NDM（右键菜单、媒体面板）。
 * Hand an explicit URL to NDM from the context menu or media panel.
 */
async function manualDownload(options) {
  const url = String(options.url || '');
  if (!isHttpUrl(url)) return { ok: false, error: 'invalid-url' };

  const tab = options.tabId >= 0 ? await getTabInfo(options.tabId) : null;
  const pageUrl = stripHash(options.pageUrl || tab?.url || '');
  if (isRequestBlocked({ url, initiator: pageUrl, tabUrl: tab?.url, rules: blockedSites })) {
    if (options.tabId >= 0) {
      void sendTabMessage(options.tabId, {
        type: MSG.SHOW_TOAST,
        text: t('siteBlockedShort', 'Blocked on this site')
      });
    }
    return { ok: false, error: 'site-blocked' };
  }

  const contentType = normalizeMime(options.contentType || '');
  const ext = extensionOf(url) || extensionFromMime(contentType) || extensionOfName(options.filename);
  const kind = normalizeKind(options.kind, url, contentType, ext);
  const cookies = await getCookieHeader(url, tab?.url || pageUrl);
  const title = options.title || tab?.title || hostnameOf(pageUrl) || hostnameOf(url);
  const description = options.description || describeCapture({ kind, ext, size: options.size, contentType });
  const payload = createPayload({
    url,
    method: 'GET',
    kind,
    title,
    description,
    filename: options.filename || filenameFrom(url, options.contentDisposition || ''),
    pageUrl,
    cookies,
    responseContentType: contentType,
    contentDisposition: options.contentDisposition || '',
    size: Number(options.size) || 0,
    headers: options.headers || {},
    postData: ''
  });

  const sent = await sendToNdm(payload, {
    expectBrowserDownload: false,
    waitMs: Number(options.waitMs) || 1800,
    tab
  });

  return sent
    ? { ok: true, ndm: ndm.getState() }
    : { ok: false, error: 'ndm-unavailable', ndm: ndm.getState() };
}

/* -------------------------------------------------------------------------- */
/* NDM payloads                                                               */
/* -------------------------------------------------------------------------- */

function createPayload({
  url,
  method = 'GET',
  kind = 'normal',
  title = '',
  description = '',
  filename = '',
  pageUrl = '',
  cookies = '',
  requestContentType = '',
  responseContentType = '',
  contentType = '',
  contentDisposition = '',
  size = 0,
  headers = {},
  postData = ''
}) {
  const cleanPage = stripHash(pageUrl);
  return {
    url,
    method,
    type: kind,
    title: sanitizeHeaderValue(title).slice(0, 300),
    description: sanitizeHeaderValue(description).slice(0, 300),
    filename: safeFilename(filename || filenameFrom(url, contentDisposition)),
    pageUrl: cleanPage,
    referer: cleanPage,
    origin: originOf(cleanPage) || originOf(url),
    cookies,
    requestContentType,
    responseContentType: responseContentType || contentType,
    contentDisposition,
    size: Math.max(0, Number(size) || 0),
    headers,
    postData
  };
}

/**
 * 发送并记录最近捕获；仅在成功时登记浏览器下载取消。
 * Send, record the capture, and register browser-download cancellation only on success.
 */
async function sendToNdm(payload, { expectBrowserDownload = false, waitMs = 0, tab = null } = {}) {
  if (!payload || !payload.url) return false;
  const url = payload.url;
  const sent = await ndm.send(payload, { waitMs });
  if (!sent) {
    ndm.ensureConnected();
    return false;
  }

  recentSent.set(url, Date.now() + 12_000);
  pruneExpiring(recentSent, LIMITS.recentSent);
  if (expectBrowserDownload && settings.autoCancelBrowserDownload) {
    pendingCancel.set(url, Date.now() + 15_000);
    pruneExpiring(pendingCancel, LIMITS.pendingCancel);
  }

  addRecent({
    url,
    filename: payload.filename,
    kind: payload.type,
    size: payload.size,
    host: hostnameOf(url),
    time: Date.now(),
    title: payload.title
  });
  return true;
}

/**
 * NDM 等待缺失的大小/类型时，用 HEAD 补齐一次。
 * Fill a missing size/content type once when NDM reports that it is waiting.
 */
async function handleNdmWaiting(payload) {
  if (!payload || !isHttpUrl(payload.url)) return;
  if (String(payload.method || 'GET').toUpperCase() === 'POST') return;
  if (payload.size > 0 && (payload.responseContentType || payload.contentType)) return;

  const now = Date.now();
  if ((waitingFetches.get(payload.url) || 0) > now) return;
  waitingFetches.set(payload.url, now + 15_000);
  pruneExpiring(waitingFetches, 100);

  try {
    const response = await fetch(payload.url, {
      method: 'HEAD',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store'
    });
    if (!response.ok) return;
    const size = Number(response.headers.get('content-length')) || 0;
    const contentType = response.headers.get('content-type') || '';
    if (!size && !contentType) return;
    await ndm.send({
      ...payload,
      size: payload.size || size,
      responseContentType: payload.responseContentType || contentType
    });
  } catch {
    // HEAD 失败时保持原任务，不丢下载 / Keep the original task when HEAD fails.
  }
}

function addRecent(entry) {
  recentCaptures = [entry, ...recentCaptures].slice(0, LIMITS.recentCaptures);
  void saveSessionState({ recentCaptures });
  scheduleBroadcast();
}

function describeCapture({ kind, ext, size, contentType = '' }) {
  let label = t('fileTypeFile', 'File');
  if (kind === 'hls') label = t('fileTypeHls', 'HLS');
  else if (String(contentType).startsWith('audio/')) label = t('fileTypeAudio', 'Audio');
  else if (String(contentType).startsWith('video/')) label = t('fileTypeVideo', 'Video');
  return [label, ext, formatBytes(size)].filter(Boolean).join(' · ');
}

function normalizeKind(kind, url, contentType, ext) {
  if (kind === 'hls') return 'hls';
  if (HLS_EXTENSIONS.has(ext) || HLS_MIMES.has(normalizeMime(contentType))) return 'hls';
  if (kind === 'media' || kind === 'video' || kind === 'audio') return 'media';
  if (MEDIA_EXTENSIONS.has(ext) || /^(video|audio)\//.test(normalizeMime(contentType))) return 'media';
  return 'normal';
}

function extensionOfName(value) {
  const name = String(value || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}

/* -------------------------------------------------------------------------- */
/* Cookies                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 读取目标站点的 Cookie 并拼成请求头。
 * Read cookies for the target URL and build a Cookie header.
 */
async function getCookieHeader(url, topPageUrl) {
  const filters = [{ url }];
  const topLevelSite = originOf(topPageUrl);
  if (topLevelSite) {
    filters.push({ url, partitionKey: { topLevelSite } });
  }

  const all = [];
  for (const filter of filters) {
    try {
      const cookies = await cookiesGetAll(filter);
      for (const cookie of cookies) all.push(cookie);
    } catch {
      // 分区 Cookie 失败时回退到普通 Cookie / Fall back to unpartitioned cookies.
    }
  }

  const seen = new Set();
  const unique = [];
  for (const cookie of all) {
    if (!cookie || !cookie.name) continue;
    const partition = cookie.partitionKey?.topLevelSite || '';
    const key = `${cookie.storeId}|${cookie.domain}|${cookie.path}|${cookie.name}|${partition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cookie);
  }
  unique.sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0));

  let header = '';
  for (const cookie of unique) {
    const pair = `${cookie.name}=${String(cookie.value || '').replace(/[\r\n;]/g, '')}`;
    if (header.length + pair.length + 2 > 48 * 1024) break;
    header += header ? `; ${pair}` : pair;
  }
  return header;
}

function cookiesGetAll(filter) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll(filter, (cookies) => {
        void chrome.runtime.lastError;
        resolve(cookies || []);
      });
    } catch {
      resolve([]);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Network capture                                                            */
/* -------------------------------------------------------------------------- */

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    onBeforeRequest(details);
  },
  { urls: ['http://*/*', 'https://*/*'], types: REQUEST_TYPES },
  ['requestBody']
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    onBeforeSendHeaders(details);
  },
  { urls: ['http://*/*', 'https://*/*'], types: REQUEST_TYPES },
  ['requestHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // 标记已看到响应头，避免 downloads 回退路径重复发送。
    // Mark the URL so the downloads fallback does not send a duplicate.
    seenHeaderUrls.set(details.url, Date.now() + 12_000);
    pruneExpiring(seenHeaderUrls, 800);

    const snapshot = {
      requestId: details.requestId,
      url: details.url,
      method: details.method,
      type: details.type,
      statusCode: details.statusCode,
      tabId: details.tabId,
      frameId: details.frameId,
      initiator: details.initiator || '',
      documentUrl: details.documentUrl || '',
      contentType: getHeader(details.responseHeaders, 'content-type'),
      contentDisposition: getHeader(details.responseHeaders, 'content-disposition'),
      contentLength: Number.isFinite(Number(getHeader(details.responseHeaders, 'content-length')))
        && getHeader(details.responseHeaders, 'content-length') !== ''
        ? Number(getHeader(details.responseHeaders, 'content-length'))
        : undefined,
      contentRange: getHeader(details.responseHeaders, 'content-range'),
      acceptRanges: getHeader(details.responseHeaders, 'accept-ranges')
    };
    // 快速排除图片、字体、HTML 等普通资源，减少页面开销。
    // Quickly skip ordinary assets to keep page overhead low.
    if (isObviousBrowserAsset(snapshot)) {
      requestContexts.delete(details.requestId);
      return;
    }
    void processHeaders(snapshot);
  },
  { urls: ['http://*/*', 'https://*/*'], types: REQUEST_TYPES },
  ['responseHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    requestContexts.delete(details.requestId);
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    requestContexts.delete(details.requestId);
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    requestContexts.delete(details.requestId);
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

/**
 * 记录请求上下文，不在此阶段判断下载。
 * Record request context; download decisions happen after response headers arrive.
 */
function onBeforeRequest(details) {
  if (!settings.captureEnabled) return;
  if (!isHttpUrl(details.url)) return;
  if (!initialized) void ensureInit();
  if (isBypassed()) return;

  const tab = details.tabId >= 0 ? tabInfo.get(details.tabId) : null;
  // 子框架使用 documentUrl 作为 Referer / Subframes use documentUrl as the referrer.
  const pageUrl = details.type === 'main_frame'
    ? (tab?.url || details.initiator || '')
    : (details.documentUrl || tab?.url || details.initiator || '');
  if (isRequestBlocked({ url: details.url, initiator: details.initiator, documentUrl: details.documentUrl, tabUrl: tab?.url, rules: blockedSites })) {
    return;
  }

  const method = String(details.method || 'GET').toUpperCase();
  const body = method === 'POST'
    ? serializeRequestBody(details.requestBody)
    : { text: '', contentType: '' };
  let bodyForm = null;
  if (method === 'POST' && details.requestBody?.formData) {
    bodyForm = {};
    for (const [name, values] of Object.entries(details.requestBody.formData)) {
      bodyForm[name] = Array.isArray(values) ? values.map((value) => String(value)) : [];
    }
  }
  const context = {
    url: details.url,
    method,
    type: details.type,
    tabId: details.tabId,
    frameId: details.frameId,
    initiator: details.initiator || '',
    documentUrl: details.documentUrl || '',
    pageUrl,
    title: tab?.title || '',
    bodyText: body.text,
    bodyContentType: body.contentType,
    bodyForm,
    requestHeaders: null,
    createdAt: Date.now()
  };

  requestContexts.set(details.requestId, context);
  requestCounter += 1;
  if (requestCounter % 40 === 0) pruneRequestContexts();
  if (requestContexts.size > LIMITS.requestContexts) {
    const first = requestContexts.keys().next().value;
    if (first) requestContexts.delete(first);
  }
}

function isObviousBrowserAsset(snapshot) {
  const disposition = String(snapshot.contentDisposition || '').toLowerCase();
  if (disposition.startsWith('attachment')) return false;
  if (HLS_EXTENSIONS.has(extensionOf(snapshot.url))) return false;
  const mime = normalizeMime(snapshot.contentType);
  if (!mime) return false;
  if (mime.startsWith('image/') || mime.startsWith('font/')) return true;
  return NON_DOWNLOAD_MIMES.has(mime);
}

function onBeforeSendHeaders(details) {
  const context = requestContexts.get(details.requestId);
  if (!context) return;
  context.requestHeaders = details.requestHeaders || [];
  if (!context.bodyContentType) {
    context.bodyContentType = getHeader(context.requestHeaders, 'content-type');
  }
  if (context.bodyForm) {
    const body = serializeRequestBody({ formData: context.bodyForm }, context.bodyContentType);
    context.bodyText = body.text;
    context.bodyContentType = body.contentType;
    context.bodyForm = null;
  }
}

function pruneRequestContexts() {
  const cutoff = Date.now() - LIMITS.contextAgeMs;
  for (const [id, context] of requestContexts) {
    if (!context || context.createdAt < cutoff) requestContexts.delete(id);
  }
}

/**
 * 根据响应头和页面上下文决定是否捕获。
 * Decide from response headers and page context.
 */
async function processHeaders(snapshot) {
  const context = requestContexts.get(snapshot.requestId) || {};
  try {
    await ensureInit();
    if (!settings.captureEnabled) return;
    if (!ndm.getState().connected) return;
    if (isBypassed()) return;

    const tab = snapshot.tabId >= 0 ? tabInfo.get(snapshot.tabId) : null;
    let pageUrl = context.pageUrl
      || snapshot.documentUrl
      || (snapshot.type !== 'main_frame' ? tab?.url : '')
      || snapshot.initiator
      || '';
    // 顶层导航时标签页 URL 可能已变成目标地址，此时退回 initiator。
    // During a top-level navigation the tab URL may already be the target; fall back to initiator.
    if (snapshot.type === 'main_frame' && stripHash(pageUrl) === stripHash(snapshot.url)) {
      pageUrl = snapshot.initiator || '';
    }
    const tabUrl = tab?.url || pageUrl;
    if (isRequestBlocked({
      url: snapshot.url,
      initiator: snapshot.initiator,
      documentUrl: snapshot.documentUrl,
      tabUrl,
      rules: blockedSites
    })) {
      return;
    }

    const decision = decideCapture({
      url: snapshot.url,
      method: snapshot.method,
      type: snapshot.type,
      statusCode: snapshot.statusCode,
      contentType: snapshot.contentType,
      contentDisposition: snapshot.contentDisposition,
      contentLength: snapshot.contentLength,
      contentRange: snapshot.contentRange,
      captureEnabled: settings.captureEnabled,
      captureMedia: settings.captureMedia,
      mediaMinSize: settings.mediaMinSize,
      ndmConnected: ndm.getState().connected,
      blocked: false,
      bypass: false
    });

    if (!decision.capture) return;

    // 网络媒体同时放入页面媒体面板，解决 blob/MSE 页面没有 <video src> 的问题。
    // Also add network media to the panel for blob/MSE pages without a direct <video src>.
    if (settings.showMediaPanel && (decision.kind === 'media' || decision.kind === 'hls') && snapshot.tabId >= 0) {
      const panelContentType = String(snapshot.contentType || decision.contentType || '');
      const panelLabel = decision.filename && decision.filename !== 'download'
        ? decision.filename
        : describeCapture({
          kind: decision.kind,
          ext: decision.ext,
          size: decision.size,
          contentType: panelContentType
        });
      void addNetworkMedia(snapshot.tabId, {
        url: snapshot.url,
        kind: panelContentType.startsWith('audio/') ? 'audio' : 'video',
        label: panelLabel,
        ext: decision.ext,
        size: decision.size,
        pageUrl,
        frameUrl: context.documentUrl || pageUrl
      });
    }

    if (isRecentlySent(snapshot.url)) {
      if (settings.autoCancelBrowserDownload) markPendingCancel(snapshot.url);
      return;
    }

    const title = context.title || tab?.title || hostnameOf(pageUrl) || hostnameOf(snapshot.url);
    const contentType = snapshot.contentType || decision.contentType;
    const description = describeCapture({
      kind: decision.kind,
      ext: decision.ext,
      size: decision.size,
      contentType
    });

    // 立即登记 in-flight，供 downloads.onCreated 等待，避免重复发送。
    // Register in-flight immediately so downloads.onCreated can wait instead of sending twice.
    const task = (async () => {
      const cookies = await getCookieHeader(snapshot.url, tab?.url || pageUrl);
      const payload = createPayload({
        url: snapshot.url,
        method: snapshot.method,
        kind: decision.kind,
        title,
        description,
        filename: decision.filename,
        pageUrl,
        cookies,
        requestContentType: context.bodyContentType || '',
        responseContentType: contentType,
        contentDisposition: snapshot.contentDisposition,
        size: decision.size,
        headers: headersToObject(context.requestHeaders),
        postData: context.bodyText || ''
      });
      return sendToNdm(payload, { expectBrowserDownload: true, waitMs: 0, tab });
    })();

    inflightCaptures.set(snapshot.url, task);
    void task.catch(() => null).finally(() => {
      setTimeout(() => {
        if (inflightCaptures.get(snapshot.url) === task) inflightCaptures.delete(snapshot.url);
      }, 5000);
    });
    await task;
  } catch (error) {
    console.warn('[OpenNDM] capture failed', error);
  } finally {
    requestContexts.delete(snapshot.requestId);
  }
}

function headersToObject(headers) {
  const result = {};
  if (!Array.isArray(headers)) return result;
  for (const header of headers) {
    const name = String(header?.name || '');
    if (!name) continue;
    const value = String(header?.value ?? header?.binaryValue ?? '');
    if (!value) continue;
    if (!/^x-/i.test(name) && name.toLowerCase() !== 'authorization') continue;
    result[name] = value;
  }
  return result;
}

function isRecentlySent(url) {
  const expires = recentSent.get(url);
  if (!expires) return false;
  if (expires <= Date.now()) {
    recentSent.delete(url);
    return false;
  }
  return true;
}

function markPendingCancel(url) {
  if (!settings.autoCancelBrowserDownload) return;
  pendingCancel.set(url, Date.now() + 15_000);
  pruneExpiring(pendingCancel, LIMITS.pendingCancel);
}

function pruneExpiring(map, limit) {
  const now = Date.now();
  for (const [key, expires] of map) {
    if (expires <= now) map.delete(key);
  }
  while (map.size > limit) {
    const first = map.keys().next().value;
    if (!first) break;
    map.delete(first);
  }
}

/* -------------------------------------------------------------------------- */
/* Browser download fallback                                                  */
/* -------------------------------------------------------------------------- */

chrome.downloads.onCreated.addListener((item) => {
  void onBrowserDownload(item);
});

/**
 * 接管浏览器原生下载：已由 webRequest 捕获的直接取消，否则补发一次。
 * Take over native downloads: cancel ones already captured, otherwise forward once.
 */
async function onBrowserDownload(item) {
  try {
    await ensureInit();
    if (!settings.captureEnabled || !settings.autoCancelBrowserDownload) return;
    if (!item || item.byExtensionId === chrome.runtime.id) return;
    if (!isHttpUrl(item.url)) return;
    if (isBypassed()) return;

    const tab = item.tabId >= 0 ? await getTabInfo(item.tabId) : null;
    const pageUrl = stripHash(item.referrer || tab?.url || '');
    if (isRequestBlocked({ url: item.url, initiator: pageUrl, tabUrl: tab?.url, rules: blockedSites })) {
      return;
    }

    const directPending = pendingCancel.get(item.url) || pendingCancel.get(item.finalUrl);
    if (directPending && directPending > Date.now()) {
      cancelDownload(item.id);
      return;
    }

    const inflight = inflightCaptures.get(item.url) || inflightCaptures.get(item.finalUrl);
    if (inflight) {
      const sent = await withTimeout(inflight, 2500);
      if (sent && settings.autoCancelBrowserDownload) cancelDownload(item.id);
      return;
    }

    if (isRecentlySent(item.url) || isRecentlySent(item.finalUrl)) {
      cancelDownload(item.id);
      return;
    }
    if (!ndm.getState().connected) return;

    // webRequest 已看到该响应时，给异步捕获一个短暂窗口，避免重复发送。
    // If webRequest already saw this response, give the async capture a short window.
    const seenUntil = Math.max(seenHeaderUrls.get(item.url) || 0, seenHeaderUrls.get(item.finalUrl) || 0);
    if (seenUntil > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const latePending = pendingCancel.get(item.url) || pendingCancel.get(item.finalUrl);
      if (latePending && latePending > Date.now()) {
        cancelDownload(item.id);
        return;
      }
      const lateInflight = inflightCaptures.get(item.url) || inflightCaptures.get(item.finalUrl);
      if (lateInflight) {
        const sent = await withTimeout(lateInflight, 2500);
        if (sent && settings.autoCancelBrowserDownload) cancelDownload(item.id);
        return;
      }
      if (isRecentlySent(item.url) || isRecentlySent(item.finalUrl)) {
        cancelDownload(item.id);
        return;
      }
      return;
    }

    const contentType = normalizeMime(item.mime || '');
    const ext = extensionOf(item.url) || extensionFromMime(contentType) || extensionOfName(item.filename);
    const kind = normalizeKind(null, item.url, contentType, ext);
    if (settings.captureMedia === false && kind !== 'normal') return;
    const localName = item.filename ? safeFilename(String(item.filename).split(/[\\/]/).pop()) : '';
    const filename = localName || filenameFrom(item.url, '');
    const size = Math.max(0, Number(item.fileSize) || Number(item.totalBytes) || 0);
    const cookies = await getCookieHeader(item.url, tab?.url || pageUrl);
    const title = tab?.title || hostnameOf(pageUrl) || hostnameOf(item.url);
    const description = describeCapture({ kind, ext, size, contentType });
    const payload = createPayload({
      url: item.url,
      method: 'GET',
      kind,
      title,
      description,
      filename,
      pageUrl,
      cookies,
      responseContentType: contentType,
      contentDisposition: '',
      size,
      headers: {},
      postData: ''
    });

    const sent = await sendToNdm(payload, { expectBrowserDownload: false, waitMs: 1200, tab });
    if (sent) cancelDownload(item.id);
  } catch (error) {
    console.warn('[OpenNDM] browser download fallback failed', error);
  }
}

function cancelDownload(id) {
  if (!Number.isInteger(id)) return;
  try {
    chrome.downloads.cancel(id, () => {
      if (chrome.runtime.lastError) return;
      chrome.downloads.erase({ id }, () => void chrome.runtime.lastError);
    });
  } catch {
    // 下载可能已经完成 / The download may already be complete.
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

/* -------------------------------------------------------------------------- */
/* Media panel aggregation                                                    */
/* -------------------------------------------------------------------------- */

async function addNetworkMedia(tabId, item) {
  if (!Number.isInteger(tabId) || tabId < 0 || !item || !isHttpUrl(item.url)) return;
  const map = mediaByTab.get(tabId) || new Map();
  if (map.has(item.url)) return;
  if (map.size >= LIMITS.mediaPerTab) {
    const first = map.keys().next().value;
    if (first) map.delete(first);
  }
  map.set(item.url, {
    url: item.url,
    kind: item.kind === 'audio' ? 'audio' : 'video',
    label: String(item.label || filenameFrom(item.url, '')).slice(0, 140),
    ext: item.ext || extensionOf(item.url),
    size: Math.max(0, Number(item.size) || 0),
    pageUrl: stripHash(item.pageUrl || ''),
    frameUrl: stripHash(item.frameUrl || item.pageUrl || '')
  });
  mediaByTab.set(tabId, map);
  await sendTabMessage(tabId, {
    type: MSG.MEDIA_ADD,
    items: [...map.values()]
  }, { frameId: 0 });
}

async function handleMediaFound(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: 'no-tab' };
  if (!settings.captureEnabled || !settings.showMediaPanel) return { ok: false, error: 'disabled' };

  const pageUrl = stripHash(message.pageUrl || sender.tab?.url || '');
  if (isRequestBlocked({ url: pageUrl, initiator: pageUrl, tabUrl: sender.tab?.url, rules: blockedSites })) {
    return { ok: false, error: 'site-blocked' };
  }

  const items = Array.isArray(message.items) ? message.items.slice(0, 12) : [];
  const map = mediaByTab.get(tabId) || new Map();
  let accepted = 0;

  for (const item of items) {
    if (!item || !isHttpUrl(item.url)) continue;
    const url = item.url;
    if (isRequestBlocked({ url, initiator: pageUrl, tabUrl: sender.tab?.url, rules: blockedSites })) continue;
    const normalized = {
      url,
      kind: item.kind === 'audio' ? 'audio' : item.kind === 'video' ? 'video' : 'media',
      label: String(item.label || '').slice(0, 140),
      ext: extensionOf(url) || String(item.ext || '').toUpperCase(),
      size: Math.max(0, Number(item.size) || 0),
      pageUrl,
      frameUrl: stripHash(sender.url || pageUrl)
    };
    if (!map.has(url) && map.size >= LIMITS.mediaPerTab) {
      const first = map.keys().next().value;
      if (first) map.delete(first);
    }
    map.set(url, normalized);
    accepted += 1;
  }

  mediaByTab.set(tabId, map);
  if (map.size > 0) {
    await sendTabMessage(tabId, {
      type: MSG.MEDIA_ADD,
      items: [...map.values()]
    }, { frameId: 0 });
  }
  return { ok: true, accepted, count: map.size };
}

function clearMedia(tabId, notify = false) {
  if (!Number.isInteger(tabId)) return;
  mediaByTab.delete(tabId);
  if (notify) {
    void sendTabMessage(tabId, { type: MSG.MEDIA_CLEAR }, { frameId: 0 });
  }
}

/* -------------------------------------------------------------------------- */
/* Tab and navigation events                                                  */
/* -------------------------------------------------------------------------- */

chrome.tabs.onActivated.addListener((activeInfo) => {
  void chrome.tabs.get(activeInfo.tabId).then((tab) => {
    updateMenuForTab(tab);
    setTabInfo(tab);
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    setTabInfo(tab);
    clearMedia(tabId, false);
  } else if (changeInfo.title) {
    const current = tabInfo.get(tabId) || {};
    tabInfo.set(tabId, { ...current, title: changeInfo.title });
  }
  if (changeInfo.status === 'complete') {
    setTabInfo(tab);
    updateMenuForTab(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabInfo.delete(tabId);
  mediaByTab.delete(tabId);
  panelOpenTabs.delete(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  clearMedia(details.tabId, false);
  // 整页导航后回到默认最小化；SPA 路由切换保留展开状态。
  // A full navigation starts minimised again; SPA route changes keep the expanded panel.
  panelOpenTabs.delete(details.tabId);
  tabInfo.set(details.tabId, {
    ...(tabInfo.get(details.tabId) || {}),
    url: details.url
  });
  void chrome.tabs.get(details.tabId).then((tab) => {
    setTabInfo(tab);
    updateMenuForTab(tab);
  }).catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  clearMedia(details.tabId, true);
  tabInfo.set(details.tabId, {
    ...(tabInfo.get(details.tabId) || {}),
    url: details.url
  });
});

function setTabInfo(tab) {
  if (!tab || !Number.isInteger(tab.id)) return;
  tabInfo.set(tab.id, {
    url: tab.url || tabInfo.get(tab.id)?.url || '',
    title: tab.title || tabInfo.get(tab.id)?.title || ''
  });
}

async function getTabInfo(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const cached = tabInfo.get(tabId);
  if (cached?.url) return cached;
  try {
    const tab = await chrome.tabs.get(tabId);
    setTabInfo(tab);
    return tabInfo.get(tabId) || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Bypass                                                                     */
/* -------------------------------------------------------------------------- */

function isBypassed() {
  if (bypassUntil <= Date.now()) {
    if (bypassUntil !== 0) bypassUntil = 0;
    return false;
  }
  return true;
}

async function setBypass(ttlMs) {
  const ttl = Math.max(500, Math.min(10_000, Number(ttlMs) || LIMITS.bypassTtlMs));
  bypassUntil = Date.now() + ttl;
  await saveSessionState({ bypassUntil });
  return bypassUntil;
}

/* -------------------------------------------------------------------------- */
/* Messaging                                                                  */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.warn('[OpenNDM] message failed', error);
      sendResponse({ ok: false, error: 'internal-error' });
    });
  return true;
});

async function handleMessage(message, sender) {
  await ensureInit();
  if (!ndm.getState().connected) ndm.ensureConnected();
  const type = message?.type;

  switch (type) {
    case MSG.GET_STATE: {
      const tab = await resolveTab(message, sender);
      const pageUrl = tab?.url || message.pageUrl || '';
      return {
        ok: true,
        settings,
        ndm: ndm.getState(),
        blockedSites,
        recent: recentCaptures.slice(0, LIMITS.recentCaptures),
        media: tab?.id >= 0 ? [...(mediaByTab.get(tab.id)?.values() || [])] : [],
        siteBlocked: isHostBlocked(hostnameOf(pageUrl), blockedSites),
        panelOpen: Number.isInteger(tab?.id) && tab.id >= 0 ? panelOpenTabs.has(tab.id) : false,
        siteSupported: /^https?:\/\//i.test(pageUrl),
        host: hostnameOf(pageUrl),
        pageUrl,
        tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
        version: chrome.runtime.getManifest().version
      };
    }

    case MSG.SET_SETTINGS: {
      const wasPanelEnabled = settings.showMediaPanel;
      const next = await saveSettings(message.patch || {});
      settings = next;
      // 面板开关变化后回到默认最小化 / Reset to minimised when the panel setting changes.
      if (wasPanelEnabled !== settings.showMediaPanel) panelOpenTabs.clear();
      ndm.setPort(settings.ndmPort);
      updateBadge();
      updateMenuForActiveTab();
      scheduleBroadcast();
      return { ok: true, settings };
    }

    case MSG.PANEL_STATE: {
      const tabId = Number.isInteger(message.tabId) && message.tabId >= 0
        ? message.tabId
        : sender.tab?.id;
      if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: 'no-tab' };
      if (message.open) panelOpenTabs.add(tabId);
      else panelOpenTabs.delete(tabId);
      scheduleBroadcast();
      return { ok: true, open: Boolean(message.open) };
    }

    case MSG.SET_SITE_BLOCKED: {
      const host = normalizeHost(message.host || message.url || '');
      if (!host) return { ok: false, error: 'invalid-host' };
      const shouldBlock = message.blocked !== false;
      const next = shouldBlock
        ? mergeHosts(blockedSites, [host])
        : removeHostRule(host, blockedSites);
      blockedSites = await saveBlockedSites(next);
      updateMenuForActiveTab();
      scheduleBroadcast();
      if (sender.tab?.id >= 0) {
        await sendTabMessage(sender.tab.id, {
          type: MSG.SHOW_TOAST,
          text: shouldBlock
            ? t('siteBlockedToast', 'NDM disabled for this site')
            : t('siteUnblockedToast', 'NDM enabled for this site')
        });
      }
      return { ok: true, blockedSites, blocked: shouldBlock };
    }

    case MSG.REMOVE_BLOCKED_SITE: {
      const host = normalizeHost(message.host || '');
      blockedSites = await saveBlockedSites(removeHostRule(host, blockedSites));
      updateMenuForActiveTab();
      scheduleBroadcast();
      return { ok: true, blockedSites };
    }

    case MSG.BYPASS: {
      const until = await setBypass(message.ttl);
      return { ok: true, until };
    }

    case MSG.DOWNLOAD_URL: {
      const tab = await resolveTab(message, sender);
      return manualDownload({
        url: message.url,
        pageUrl: message.pageUrl || tab?.url || '',
        title: message.title || tab?.title || '',
        filename: message.filename || '',
        kind: message.kind || '',
        contentType: message.contentType || '',
        size: message.size || 0,
        tabId: tab?.id ?? -1,
        waitMs: 2000
      });
    }

    case MSG.MEDIA_FOUND:
      return handleMediaFound(message, sender);

    case MSG.PAGE_READY: {
      const tabId = sender.tab?.id;
      if (Number.isInteger(tabId)) {
        const previous = tabInfo.get(tabId)?.url || '';
        tabInfo.set(tabId, {
          url: message.pageUrl || sender.tab?.url || previous,
          title: message.title || sender.tab?.title || ''
        });
        if (previous && stripHash(previous) !== stripHash(message.pageUrl || '')) {
          clearMedia(tabId, false);
        }
      }
      return { ok: true };
    }

    case MSG.TEST_CONNECTION: {
      ndm.ensureConnected();
      const deadline = Date.now() + 2600;
      while (!ndm.getState().connected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: true, ndm: ndm.getState() };
    }

    case MSG.CLEAR_RECENT: {
      recentCaptures = [];
      await saveSessionState({ recentCaptures });
      scheduleBroadcast();
      return { ok: true };
    }

    default:
      return { ok: false, error: 'unknown-message' };
  }
}

async function resolveTab(message, sender) {
  if (sender.tab && Number.isInteger(sender.tab.id) && sender.tab.id >= 0) return sender.tab;
  if (Number.isInteger(message?.tabId) && message.tabId >= 0) {
    try {
      return await chrome.tabs.get(message.tabId);
    } catch {
      return null;
    }
  }
  if (message?.pageUrl) {
    return { id: -1, url: message.pageUrl, title: message.title || '' };
  }
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Storage, install, and keepalive                                            */
/* -------------------------------------------------------------------------- */

onStorageChanged((changes) => {
  if (changes.settings) {
    settings = normalizeSettings(changes.settings.newValue);
    ndm.setPort(settings.ndmPort);
    updateBadge();
    updateMenuForActiveTab();
    scheduleBroadcast();
  }
  if (changes.blockedSites) {
    blockedSites = mergeHosts(changes.blockedSites.newValue);
    updateMenuForActiveTab();
    scheduleBroadcast();
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await ensureInit();
    if (details.reason === 'install') {
      const stored = await chrome.storage.local.get('settings');
      if (!stored.settings) {
        await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
      }
    }
    await ensureMenus();
    await ensureKeepAliveAlarm();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureInit();
    ndm.ensureConnected();
    await ensureMenus();
    await ensureKeepAliveAlarm();
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ndm-keepalive') {
    ndm.ensureConnected();
    updateBadge();
  }
});

// 冷启动立即初始化 / Initialize immediately after a cold start.
void ensureInit();
