/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 使用最小 Chrome API 模拟加载 Service Worker。
 * Load the service worker against a minimal Chrome API mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const localStore = {};
const sessionStore = {};
const listeners = {};
let messageListener = null;

function event(name) {
  listeners[name] = listeners[name] || [];
  return {
    addListener(fn) {
      listeners[name].push(fn);
    }
  };
}

const activeTab = {
  id: 7,
  url: 'https://example.com/page',
  title: 'Example page'
};

const chromeMock = {
  runtime: {
    id: 'test-extension-id',
    lastError: undefined,
    getManifest: () => ({ version: '0.1' }),
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      }
    },
    onInstalled: event('installed'),
    onStartup: event('startup')
  },
  i18n: {
    getMessage: () => ''
  },
  storage: {
    local: {
      get(keys) {
        if (typeof keys === 'string') return Promise.resolve({ [keys]: localStore[keys] });
        if (Array.isArray(keys)) return Promise.resolve(Object.fromEntries(keys.map((key) => [key, localStore[key]])));
        return Promise.resolve({ ...localStore });
      },
      set(values) {
        Object.assign(localStore, values);
        for (const [key, value] of Object.entries(values)) {
          const handlers = listeners.storageChanged || [];
          for (const handler of handlers) handler({ [key]: { newValue: value } }, 'local');
        }
        return Promise.resolve();
      }
    },
    session: {
      get(keys) {
        if (typeof keys === 'string') return Promise.resolve({ [keys]: sessionStore[keys] });
        return Promise.resolve({ ...sessionStore });
      },
      set(values) {
        Object.assign(sessionStore, values);
        return Promise.resolve();
      }
    },
    onChanged: event('storageChanged')
  },
  tabs: {
    query: () => Promise.resolve([activeTab]),
    get: (id) => (id === activeTab.id ? Promise.resolve(activeTab) : Promise.reject(new Error('no tab'))),
    sendMessage: (...args) => {
      const callback = args.find((item) => typeof item === 'function');
      if (callback) callback(undefined);
    },
    onActivated: event('tabActivated'),
    onUpdated: event('tabUpdated'),
    onRemoved: event('tabRemoved')
  },
  contextMenus: {
    removeAll: (callback) => callback?.(),
    create: (properties, callback) => callback?.(),
    update: (id, properties, callback) => callback?.(),
    onClicked: event('contextClicked')
  },
  action: {
    setBadgeText: (properties, callback) => callback?.(),
    setBadgeBackgroundColor: (properties, callback) => callback?.(),
    setTitle: (properties, callback) => callback?.()
  },
  alarms: {
    create: () => Promise.resolve(),
    onAlarm: event('alarm')
  },
  cookies: {
    getAll: (filter, callback) => callback?.([])
  },
  downloads: {
    onCreated: event('downloadCreated'),
    cancel: (id, callback) => callback?.(),
    erase: (query, callback) => callback?.()
  },
  webNavigation: {
    onCommitted: event('committed'),
    onHistoryStateUpdated: event('history')
  },
  webRequest: {
    onBeforeRequest: event('beforeRequest'),
    onBeforeSendHeaders: event('beforeSendHeaders'),
    onHeadersReceived: event('headersReceived'),
    onCompleted: event('completed'),
    onErrorOccurred: event('errorOccurred'),
    onBeforeRedirect: event('beforeRedirect')
  }
};

globalThis.chrome = chromeMock;
globalThis.WebSocket = undefined;

const unhandled = [];
process.on('unhandledRejection', (error) => unhandled.push(error));

const module = await import('../src/background.js');
await new Promise((resolve) => setTimeout(resolve, 120));

function sendMessage(message, sender = {}) {
  return new Promise((resolve) => {
    const keepAlive = messageListener(message, sender, resolve);
    assert.equal(keepAlive, true);
  });
}

test('service worker loads and returns state', async () => {
  assert.ok(module);
  const state = await sendMessage({ type: 'GET_STATE' });
  assert.equal(state.ok, true);
  assert.equal(state.version, '0.1');
  assert.equal(state.host, 'example.com');
  assert.equal(state.settings.captureEnabled, true);
  assert.equal(state.ndm.connected, false);
});

test('settings can be updated and persisted in the mock store', async () => {
  const response = await sendMessage({ type: 'SET_SETTINGS', patch: { captureEnabled: false } });
  assert.equal(response.ok, true);
  assert.equal(response.settings.captureEnabled, false);
  const state = await sendMessage({ type: 'GET_STATE' });
  assert.equal(state.settings.captureEnabled, false);
  await sendMessage({ type: 'SET_SETTINGS', patch: { captureEnabled: true } });
});

test('blocklist toggles current site and removes parent rules', async () => {
  let response = await sendMessage({ type: 'SET_SITE_BLOCKED', host: 'example.com', blocked: true });
  assert.equal(response.ok, true);
  assert.deepEqual(response.blockedSites, ['example.com']);
  let state = await sendMessage({ type: 'GET_STATE' });
  assert.equal(state.siteBlocked, true);

  response = await sendMessage({ type: 'SET_SITE_BLOCKED', host: 'a.example.com', blocked: false });
  assert.equal(response.ok, true);
  assert.deepEqual(response.blockedSites, []);
  state = await sendMessage({ type: 'GET_STATE' });
  assert.equal(state.siteBlocked, false);
});

test('rejects invalid explicit download URLs and accepts bypass', async () => {
  const download = await sendMessage({ type: 'DOWNLOAD_URL', url: 'blob:https://example.com/id' });
  assert.equal(download.ok, false);
  assert.equal(download.error, 'invalid-url');

  const bypass = await sendMessage({ type: 'BYPASS', ttl: 1000 });
  assert.equal(bypass.ok, true);
  assert.ok(bypass.until > Date.now());
});

test('no unhandled rejection while loading', () => {
  assert.deepEqual(unhandled, []);
});
