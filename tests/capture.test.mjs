/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 集成测试：模拟 webRequest、downloads 与 WebSocket。
 * Integration test for webRequest, downloads, and the NDM socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const events = {};
const sentMessages = [];
const canceledIds = [];
let messageListener = null;

function event(name) {
  events[name] = events[name] || [];
  return { addListener(fn) { events[name].push(fn); } };
}

const tab = { id: 7, url: 'https://example.com/page', title: 'Example page' };

class FakeWebSocket {
  constructor(url, protocol) {
    this.url = url;
    this.protocol = protocol;
    FakeWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data) {
    sentMessages.push(data);
  }

  close() {
    this.onclose?.();
  }
}
FakeWebSocket.instances = [];

const chromeMock = {
  runtime: {
    id: 'capture-test',
    lastError: undefined,
    getManifest: () => ({ version: '0.1' }),
    onMessage: { addListener(fn) { messageListener = fn; } },
    onInstalled: event('installed'),
    onStartup: event('startup')
  },
  i18n: { getMessage: () => '' },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve()
    },
    session: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve()
    },
    onChanged: event('storageChanged')
  },
  tabs: {
    query: () => Promise.resolve([tab]),
    get: (id) => (id === tab.id ? Promise.resolve(tab) : Promise.reject(new Error('no tab'))),
    sendMessage: (...args) => {
      const callback = args.find((item) => typeof item === 'function');
      callback?.(undefined);
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
  cookies: { getAll: (filter, callback) => callback?.([]) },
  downloads: {
    onCreated: event('downloadCreated'),
    cancel: (id, callback) => {
      canceledIds.push(id);
      callback?.();
    },
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
globalThis.WebSocket = FakeWebSocket;

await import('../src/background.js?capture-test');
await new Promise((resolve) => setTimeout(resolve, 120));

function fireRequest({ requestId, url, type = 'main_frame', statusCode = 200, contentType = 'application/zip', contentLength = '4096' }) {
  const base = {
    requestId,
    url,
    method: 'GET',
    type,
    tabId: tab.id,
    frameId: 0,
    initiator: 'https://example.com',
    documentUrl: 'https://example.com/page'
  };
  events.beforeRequest[0]?.(base);
  events.beforeSendHeaders[0]?.({ requestId, requestHeaders: [] });
  events.headersReceived[0]?.({
    ...base,
    statusCode,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Content-Length', value: contentLength }
    ]
  });
}

test('captures a ZIP response and cancels the duplicate browser download', async () => {
  assert.equal(FakeWebSocket.instances.length > 0, true);
  fireRequest({ requestId: 'r1', url: 'https://example.com/file.zip' });
  await new Promise((resolve) => setTimeout(resolve, 120));

  // 观察窗口内出现浏览器下载且名字一致 → 发送 NDM 并取消浏览器副本。
  // A browser download with the same name arrives inside the grace window → send and cancel it.
  events.downloadCreated[0]?.({
    id: 91,
    url: 'https://example.com/file.zip',
    finalUrl: 'https://example.com/file.zip',
    tabId: tab.id,
    referrer: 'https://example.com/page',
    byExtensionId: undefined,
    filename: 'C:\\Downloads\\file.zip',
    mime: 'application/zip',
    fileSize: 4096,
    totalBytes: 4096
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const captured = sentMessages.find((message) => message.includes('2:https://example.com/file.zip'));
  assert.ok(captured);
  assert.match(captured, /\r\n6:normal\r\n/);
  assert.match(captured, /\r\n7:4096\r\n/);
  assert.match(captured, /\r\n8:application\/zip\r\n/);
  assert.deepEqual(canceledIds, [91]);
});

test('keeps Chrome\'s copy when it has a better filename', async () => {
  const before = sentMessages.length;
  const url = 'https://example.com/hash-6f2a1c9d.zip';
  fireRequest({ requestId: 'r6', url, contentType: 'application/zip', contentLength: '4096' });
  await new Promise((resolve) => setTimeout(resolve, 120));

  // 页面用 <a download> 给了友好名，NDM 只会存 hash-6f2a1c9d.zip → 保留浏览器副本。
  // The page supplied a friendly name via <a download>; NDM would keep the hash name.
  events.downloadCreated[0]?.({
    id: 95,
    url,
    finalUrl: url,
    tabId: tab.id,
    referrer: 'https://example.com/page',
    filename: 'C:\\Downloads\\驱动安装包.zip',
    mime: 'application/zip',
    fileSize: 4096,
    totalBytes: 4096
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(sentMessages.length, before);
  assert.equal(canceledIds.includes(95), false);
});

test('sends the post-redirect URL for browser downloads', async () => {
  const before = sentMessages.length;
  events.downloadCreated[0]?.({
    id: 94,
    url: 'https://example.com/go',
    finalUrl: 'https://cdn.example.com/releases/app.zip',
    tabId: tab.id,
    referrer: 'https://example.com/page',
    filename: 'C:\\Downloads\\app.zip',
    mime: 'application/zip',
    fileSize: 4096,
    totalBytes: 4096
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(sentMessages.length, before + 1);
  assert.ok(String(sentMessages[before]).includes('2:https://cdn.example.com/releases/app.zip'));
});

test('does not auto-download media played by the page', async () => {
  const before = sentMessages.length;
  fireRequest({
    requestId: 'r4',
    type: 'xmlhttprequest',
    url: 'https://cdn.example.com/show/ep1.f4v',
    contentType: 'video/x-flv',
    contentLength: '6344530'
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sentMessages.length, before);
});

test('still sends media opened directly as a navigation', async () => {
  const before = sentMessages.length;
  fireRequest({
    requestId: 'r5',
    type: 'main_frame',
    url: 'https://cdn.example.com/movie.mp4',
    contentType: 'video/mp4',
    contentLength: '8388608'
  });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(sentMessages.length, before + 1);
  assert.ok(String(sentMessages[before]).includes('https://cdn.example.com/movie.mp4'));
});

test('Ctrl bypass prevents a new capture', async () => {
  const before = sentMessages.length;
  await new Promise((resolve) => {
    messageListener({ type: 'BYPASS', ttl: 1500 }, {}, resolve);
  });
  fireRequest({ requestId: 'r2', url: 'https://example.com/skipped.zip' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(sentMessages.length, before);
});

test('does not forward restored DASH fragments to NDM', async () => {
  // 等上一个用例的 Ctrl 绕过窗口过期 / Let the previous bypass window expire first.
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const before = sentMessages.length;
  const url = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/26/70/228907026/228907026-1-100023.m4s?e=abc&deadline=1790649050';
  events.downloadCreated[0]?.({
    id: 93,
    url,
    finalUrl: url,
    tabId: tab.id,
    referrer: 'https://www.bilibili.com/video/BV1xx411c7mD',
    filename: 'C:\\Downloads\\228907026-1-100023.m4s',
    mime: 'application/octet-stream',
    fileSize: 0,
    totalBytes: 0
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sentMessages.length, before);
  assert.equal(canceledIds.includes(93), false);
});

test('blocked sites prevent capture and let the browser download', async () => {
  await new Promise((resolve) => {
    messageListener({ type: 'SET_SITE_BLOCKED', host: 'example.com', blocked: true }, {}, resolve);
  });
  const before = sentMessages.length;
  const canceledBefore = canceledIds.length;
  fireRequest({ requestId: 'r3', url: 'https://example.com/blocked.zip' });
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(sentMessages.length, before);

  events.downloadCreated[0]?.({
    id: 92,
    url: 'https://example.com/blocked.zip',
    finalUrl: 'https://example.com/blocked.zip',
    tabId: tab.id,
    referrer: 'https://example.com/page'
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(canceledIds.length, canceledBefore);
});
