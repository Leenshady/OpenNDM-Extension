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
  await new Promise((resolve) => setTimeout(resolve, 200));

  const captured = sentMessages.find((message) => message.includes('2:https://example.com/file.zip'));
  assert.ok(captured);
  assert.match(captured, /\r\n6:normal\r\n/);
  assert.match(captured, /\r\n7:4096\r\n/);
  assert.match(captured, /\r\n8:application\/zip\r\n/);

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
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(canceledIds, [91]);
});

test('captures a download Chrome confirmed after inconclusive headers', async () => {
  const before = sentMessages.length;
  const url = 'https://example.com/download/42';
  // 头部阶段无法判断（type=other），由浏览器下载事件确认后再复核规则。
  // Headers alone are inconclusive (type=other); the browser download event confirms it.
  fireRequest({ requestId: 'r8', type: 'other', url, contentType: 'application/zip', contentLength: '4096' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  events.downloadCreated[0]?.({
    id: 98,
    url,
    finalUrl: url,
    tabId: tab.id,
    referrer: 'https://example.com/page',
    filename: 'C:\\Downloads\\report.zip',
    mime: 'application/zip',
    fileSize: 4096,
    totalBytes: 4096
  });
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.ok(String(sentMessages[before]).includes('2:https://example.com/download/42'));
  assert.ok(canceledIds.includes(98));
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

test('does not forward one-time mail attachments from browser downloads', async () => {
  const before = sentMessages.length;
  const url = 'https://mail.126.com/js6/read/readdata.jsp?sid=x&mid=420:abc&part=4&mode=download&l=read&action=download_attach';
  // 头部捕获已拒绝这类链接，兜底路径也不能补发 / The header path denies these; the fallback must not resend.
  events.downloadCreated[0]?.({
    id: 97,
    url,
    finalUrl: url,
    tabId: tab.id,
    referrer: 'https://mail.126.com/js6/main.jsp?sid=x',
    filename: 'C:\\Downloads\\readdata.html',
    mime: 'text/html',
    fileSize: 20242,
    totalBytes: 20242
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(sentMessages.length, before);
  assert.equal(canceledIds.includes(97), false);
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
