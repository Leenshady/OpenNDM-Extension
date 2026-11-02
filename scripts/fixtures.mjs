/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 网页夹具测试：本地 HTTP 服务模拟各种真实下载场景，逐项断言扩展发给 NDM 的消息。
 * Fixture suite: a local HTTP server mimics real-world download scenarios and each case
 * asserts exactly what the extension hands to the (fake) NDM.
 *
 * 与站点冒烟测试不同，这里不依赖外网，且既验证"该抓的必须抓到"，也验证"不该抓的绝不抓"。
 * Unlike the site smoke test, this runs offline and asserts both directions:
 * expected captures must arrive, and anything else must never leave the browser.
 */

import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const PAYLOAD = 'OpenNDM fixture payload. '.repeat(60);

// 每个场景使用唯一 zip，避免跨场景的 recentSent 去重相互干扰。
// Each case uses its own zip so cross-case dedupe (recentSent) cannot interfere.
const ZIP_ROUTES = [
  ['/files/zip-c1.zip', 'hello-c1.bin', null],
  ['/files/post-c2.zip', 'hello-c2.bin', null],
  ['/files/zip-c3.zip', 'hello-c3.bin', null],
  ['/files/zip-c14.zip', 'hello-c14.bin', null],
  // RFC 2047 编码文件名（网易邮箱式样），扩展应把它留给浏览器。
  // NetEase-style RFC 2047 encoded filename; the extension must leave it to the browser.
  ['/files/mail-c8.zip', 'mail-c8.bin',
    { 'Content-Disposition': 'attachment; filename="=?UTF-8?B?6YKu5Lu2LnppcA==?="' }]
];

// 压缩响应：Content-Length 是压缩后字节，扩展不能把它当作文件大小发给 NDM。
// Encoded response: Content-Length describes the compressed bytes, which must not be
// reported to NDM as the file size.
const GZIP_ROUTE = '/files/gzip-c12.zip';
const GZIP_HEADERS = {
  'Content-Encoding': 'gzip',
  'Content-Disposition': 'attachment; filename="gzip-c12.zip"'
};

// 超过 96KB 的 POST 体：没有可重放的请求体，扩展必须放过。
// A POST body over the 96KB cap leaves nothing replayable, so the extension must skip it.
const BIG_POST_ROUTE = '/files/post-big-c13.zip';
const BIG_POST_BYTES = 120_000;

const MP4_BYTES = 1_536_000;
const MP4_STUB = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]),
  Buffer.alloc(MP4_BYTES - 24)
]);

/**
 * 构造一个最小的合法 zip（STORE 存储、单个内嵌文件），保证浏览器按 zip 嗅探处理。
 * Build a minimal valid zip (STORE, one embedded file) so browsers sniff it as a real archive.
 */
function makeZip(name, text) {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  // STORE 条目按原始字节写入，CRC 必须对文件数据本身计算。
  // STORE entries carry raw bytes, so the CRC32 must be computed over the file data itself.
  const crc = crc32(data);
  const nameBytes = Buffer.from(name, 'utf8');
  const localSize = 30 + nameBytes.length + data.length;
  const centralSize = 46 + nameBytes.length;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function sendBody(request, response, body, type, extra = {}, allowRange = false) {
  const headers = { 'Content-Type': type, 'Content-Length': String(body.length), ...extra };
  let source = body;
  let status = 200;
  const range = allowRange ? /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || '')) : null;
  if (range) {
    const start = Number(range[1] || 0);
    const end = range[2] ? Number(range[2]) : body.length - 1;
    if (!Number.isFinite(start) || start >= body.length || end < start) {
      response.writeHead(416, { 'Content-Type': 'text/plain' });
      response.end('bad range');
      return;
    }
    source = body.subarray(start, end + 1);
    headers['Content-Range'] = `bytes ${start}-${Math.min(end, body.length - 1)}/${body.length}`;
    headers['Content-Length'] = String(source.length);
    status = 206;
  }
  response.writeHead(status, headers);
  response.end(source);
}

function fixturePage(base) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>OpenNDM 下载夹具</title>
<link rel="stylesheet" href="${base}/style.css">
</head>
<body>
<h1>OpenNDM 下载夹具 / Download fixtures</h1>
<a id="lnk-c1" href="${base}/files/zip-c1.zip">c1 zip 直链</a>
<form id="form-c2" method="post" action="${base}/files/post-c2.zip">
  <input type="hidden" name="hello" value="world"><input type="hidden" name="n" value="42">
  <button id="btn-c2" type="submit">c2 POST 下载</button>
</form>
<a id="lnk-c4" href="${base}/bin/plain-c4">c4 octet 无扩展名</a>
<a id="lnk-c5" href="${base}/bin/attach-c5.bin">c5 附件无扩展名</a>
<a id="lnk-c6" href="${base}/page/attach.html">c6 HTML 附件</a>
<button id="btn-c7">c7 XHR 取图片</button>
<a id="lnk-c8" href="${base}/files/mail-c8.zip">c8 RFC2047 文件名</a>
<a id="lnk-c9" href="${base}/files/playlist.m3u8">c9 m3u8 清单</a>
<a id="lnk-c12" href="${base}/files/gzip-c12.zip">c12 gzip 附件</a>
<form id="form-c13" method="post" action="${base}/files/post-big-c13.zip">
  <input type="hidden" id="inp-c13" name="blob" value=""><input type="hidden" name="hello" value="world">
  <button id="btn-c13" type="submit">c13 超大 POST 体</button>
</form>
<a id="lnk-c14" href="${base}/redirect-c14.zip">c14 302 跳转到 zip</a>
<button id="btn-c10">c10 blob 下载</button>
<script>
// 运行时给每个场景 URL 追加唯一参数，保证不被跨场景去重。
// Append a unique query at runtime so every case touches a distinct URL.
(function () {
  var base = location.href.split('?')[0].replace(/\\/$/, '');
  document.querySelectorAll('[id^="lnk-"],[id^="form-"]').forEach(function (el) {
    var isForm = el.tagName === 'FORM';
    var attr = isForm ? 'action' : 'href';
    var url = el.getAttribute(attr) || '';
    if (url.indexOf(base) === 0) el.setAttribute(attr, url + '?r=' + el.id);
  });
  // 超过扩展请求体上限的 POST：120KB 表单值在页面装载时写入，避免污染夹具源码。
  // A POST body over the extension's cap; filled at load so the fixture source stays small.
  document.getElementById('inp-c13').value = new Array(120001).join('x');
  document.getElementById('btn-c7').addEventListener('click', function () {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', base + '/asset.png?r=btn-c7');
    xhr.send();
  });
  document.getElementById('btn-c10').addEventListener('click', function () {
    var url = URL.createObjectURL(new Blob(['openndm blob fixture'], { type: 'text/plain' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'fixture-blob.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });
})();
</script>
</body>
</html>`;
}

function videoPage(base) {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>OpenNDM 视频夹具</title></head>
<body>
<h1>video preload=metadata</h1>
<video id="v" src="${base}/seg.mp4?r=c12" preload="metadata" controls></video>
</body>
</html>`;
}

/**
 * 夹具 HTTP 服务：只提供响应头/状态码多样的下载场景，本身不含任何捕获逻辑。
 * Fixture HTTP server: varied response headers/status codes only, no capture logic.
 */
export function createFixtureServer() {
  const routes = new Map();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const base = routes.get('__base__');
    if (path === '/' || path === '/index.html') {
      sendBody(request, response, Buffer.from(fixturePage(base), 'utf8'), 'text/html; charset=utf-8');
      return;
    }
    if (path === '/video.html') {
      sendBody(request, response, Buffer.from(videoPage(base), 'utf8'), 'text/html; charset=utf-8');
      return;
    }
    if (path === '/style.css') {
      sendBody(request, response, Buffer.from('body{font-family:sans-serif}\n', 'utf8'), 'text/css');
      return;
    }
    if (path === '/asset.png' || path === '/favicon.ico') {
      sendBody(request, response, PNG_1PX, 'image/png');
      return;
    }
    if (path === '/seg.mp4') {
      sendBody(request, response, MP4_STUB, 'video/mp4', { 'Accept-Ranges': 'bytes' }, true);
      return;
    }
    if (path === '/bin/plain-c4') {
      sendBody(request, response, Buffer.from(PAYLOAD, 'utf8'), 'application/octet-stream');
      return;
    }
    if (path === '/bin/attach-c5.bin') {
      sendBody(request, response, Buffer.from(PAYLOAD, 'utf8'), 'application/octet-stream',
        { 'Content-Disposition': 'attachment; filename="download-c5.bin"' });
      return;
    }
    if (path === '/page/attach.html') {
      sendBody(request, response, Buffer.from('<h1>attached html c6</h1>', 'utf8'), 'text/html; charset=utf-8',
        { 'Content-Disposition': 'attachment; filename="report-c6.html"' });
      return;
    }
    if (path === '/files/playlist.m3u8') {
      sendBody(request, response,
        Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nseg-1.ts\n#EXT-X-ENDLIST\n', 'utf8'),
        'application/vnd.apple.mpegurl');
      return;
    }
    if (path === '/redirect-c14.zip') {
      // 302 之后才是真实文件；一条消息都不能多发 / The file arrives after a 302; nothing may be sent twice.
      const query = new URL(request.url, 'http://127.0.0.1').search;
      response.writeHead(302, { Location: `/files/zip-c14.zip${query}` });
      response.end();
      return;
    }
    if (path === BIG_POST_ROUTE) {
      // 先读完超大请求体再回应，避免浏览器等待 100-continue。
      // Drain the oversized body first so Chrome is not left waiting for a 100-continue.
      request.resume();
      request.on('end', () => sendBody(request, response, routes.get(path).body, 'application/zip', {}));
      return;
    }
    const zip = routes.get(path);
    if (zip) {
      sendBody(request, response, zip.body, 'application/zip', zip.headers || {});
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });

  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  return {
    routes,
    async prepare() {
      for (const [path, name, headers] of ZIP_ROUTES) {
        routes.set(path, { body: await makeZip(name, PAYLOAD), headers: headers || undefined });
      }
      routes.set(GZIP_ROUTE, {
        body: gzipSync(await makeZip('gzip-c12.bin', PAYLOAD)),
        headers: GZIP_HEADERS
      });
      routes.set(BIG_POST_ROUTE, { body: await makeZip('hello-c13.bin', PAYLOAD), headers: undefined });
    },
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          routes.set('__base__', `http://127.0.0.1:${port}`);
          resolvePromise(`http://127.0.0.1:${port}`);
        });
      });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 场景定义                                                                    */
/* path/count/match 断言发往假 NDM 的消息；direct 表示直接导航而不是页面内点击。                */
/* -------------------------------------------------------------------------- */

export function buildScenarios(base) {
  return [
    {
      id: 1, name: 'zip 直链导航应捕获（headers 或 downloads 兜底）',
      action: `document.getElementById('lnk-c1').click()`,
      path: '/files/zip-c1.zip', count: [1, 1], match: ['6:normal']
    },
    {
      id: 2, name: 'POST 表单下载应捕获且带请求体',
      action: `document.getElementById('btn-c2').click()`,
      path: '/files/post-c2.zip', count: [1, 1], match: ['1:POST', '__0NeatPostData9__:hello=world']
    },
    {
      id: 3, name: '直接导航到 zip 应捕获',
      direct: `${base}/files/zip-c3.zip`,
      path: '/files/zip-c3.zip', count: [1, 1], match: ['6:normal']
    },
    {
      id: 4, name: 'octet-stream 无扩展名导航应捕获（forced-download）',
      direct: `${base}/bin/plain-c4`,
      path: '/bin/plain-c4', count: [1, 1], match: ['6:normal']
    },
    {
      id: 5, name: 'Content-Disposition 附件（无扩展名 URL）应捕获',
      action: `document.getElementById('lnk-c5').click()`,
      path: '/bin/attach-c5.bin', count: [1, 1]
    },
    {
      id: 6, name: 'HTML 以附件返回应捕获',
      action: `document.getElementById('lnk-c6').click()`,
      path: '/page/attach.html', count: [1, 1]
    },
    {
      id: 7, name: '视频页加载与 video 元素（元数据/206）不得触发下载',
      direct: `${base}/video.html`, settle: 3000,
      path: '/seg.mp4', forbid: ['/video.html', '/media.mp4'], count: [0, 0]
    },
    {
      id: 8, name: 'XHR 取回的图片资源不得发送',
      action: `(async()=>{document.getElementById('btn-c7').click();await new Promise(r=>setTimeout(r,1500));return 'ok';})()`,
      path: '/asset.png', count: [0, 0]
    },
    {
      id: 9, name: 'RFC 2047 文件名应留给浏览器',
      action: `document.getElementById('lnk-c8').click()`,
      path: '/files/mail-c8.zip', count: [0, 0]
    },
    {
      id: 10, name: 'm3u8 清单应捕获为 hls',
      action: `document.getElementById('lnk-c9').click()`,
      path: '/files/playlist.m3u8', count: [1, 1], match: ['6:hls']
    },
    {
      id: 11, name: 'blob 下载不得发给 NDM',
      action: `(async()=>{document.getElementById('btn-c10').click();await new Promise(r=>setTimeout(r,1500));return 'ok';})()`,
      path: null, count: [0, 0], whole: true
    },
    {
      id: 12, name: 'gzip 附件应捕获，但不得上报压缩大小',
      action: `document.getElementById('lnk-c12').click()`,
      path: '/files/gzip-c12.zip', count: [1, 1], match: ['6:normal'], notMatch: ['7:']
    },
    {
      id: 13, name: '请求体超过上限的 POST 不得接管',
      action: `document.getElementById('btn-c13').click()`,
      path: '/files/post-big-c13.zip', count: [0, 0]
    },
    {
      id: 14, name: '302 跳转后的 zip 只发一条',
      action: `document.getElementById('lnk-c14').click()`,
      path: '/files/zip-c14.zip', count: [1, 1], match: ['6:normal'], forbid: ['/redirect-c14.zip']
    }
  ];
}

/* -------------------------------------------------------------------------- */
/* 驱动                                                                        */
/* -------------------------------------------------------------------------- */

function messageUrl(message) {
  const line = String(message.text || '').split('\r\n').find((item) => item.startsWith('2:'));
  return line ? line.slice(2) : '';
}

function messageMatches(message, scenario) {
  if (scenario.whole || scenario.path === null) return true;
  return messageUrl(message).includes(scenario.path);
}

function counting(messages, marker, scenario) {
  return messages.slice(marker).filter((message) => messageMatches(message, scenario)).length;
}

/**
 * 在夹具页面上逐个执行场景，并断言假 NDM 收到的消息。
 * Runs every scenario against the fixture page and asserts what the fake NDM received.
 */
export async function runScenarios({ cdp, sleep, waitFor, base, messages, scenarios }) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const evaluate = async (expression) => {
    try {
      const result = await cdp.send('Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result?.exceptionDetails) {
        return { ok: false, value: result.exceptionDetails.text || 'exception' };
      }
      return { ok: true, value: result?.result?.value };
    } catch (error) {
      return { ok: false, value: error.message };
    }
  };

  const goBase = async () => {
    await cdp.send('Page.navigate', { url: `${base}/index.html` }, sessionId);
    // 夹具页一定会导航成功；zip/附件类目标会被浏览器转成下载，页面可能停留在原地址，
    // 所以只等短暂时间，不对 location 做硬断言。
    // The fixture page always loads; zip/attachment targets turn into downloads and the tab
    // may keep the old document, so wait briefly and never assert location for those.
    await sleep(600);
    const loaded = await waitFor(async () => {
      const result = await evaluate('document.readyState');
      return result.ok && result.value === 'complete';
    }, 4000, 150);
    if (!loaded) throw new Error('夹具页加载超时 / fixture page did not load');
    await sleep(300);
  };

  const results = [];
  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await goBase();

    for (const scenario of scenarios) {
      const started = Date.now();
      await goBase();
      const marker = messages.length;

      if (scenario.direct) {
        await cdp.send('Page.navigate', { url: scenario.direct }, sessionId);
        await sleep(500);
      }
      let actionResult = { ok: true, value: null };
      if (scenario.action) actionResult = await evaluate(scenario.action);

      const problems = [];
      if (scenario.count[0] > 0) {
        const arrived = await waitFor(() => counting(messages, marker, scenario) >= scenario.count[0], 8000, 150);
        await sleep(1200);
        if (!arrived) problems.push(`未捕获：期望 ${scenario.count[0]} 条，实际 ${counting(messages, marker, scenario)} 条`);
      } else {
        await sleep(scenario.settle || 3000);
      }

      const list = messages.slice(marker).filter((message) => messageMatches(message, scenario));
      if (!actionResult.ok) problems.push(`动作失败: ${actionResult.value}`);
      if (scenario.count[0] > 0 && list.length > scenario.count[1]) {
        problems.push(`重复发送：收到 ${list.length} 条（预期 ${scenario.count[1]}）`);
      }
      if (scenario.count[0] === 0 && list.length > 0) {
        problems.push(`不该捕获：收到 ${list.length} 条`);
      }
      for (const needle of scenario.match || []) {
        if (!list.some((message) => String(message.text).includes(needle))) problems.push(`消息缺少 ${needle}`);
      }
      for (const absent of scenario.notMatch || []) {
        // notMatch 按整行前缀判定：URL 里的数字不能被当成协议字段。
        // notMatch compares whole line prefixes; digits inside the URL must not count as a field.
        const hit = list.find((message) => String(message.text)
          .split('\r\n')
          .some((line) => line.startsWith(absent)));
        if (hit) problems.push(`消息不该有 ${absent} 行：${messageUrl(hit)}`);
      }
      for (const forbidden of scenario.forbid || []) {
        const hit = messages.slice(marker).find((message) => messageUrl(message).includes(forbidden));
        if (hit) problems.push(`不该捕获 ${forbidden}：${messageUrl(hit)}`);
      }

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const mark = problems.length ? '✖' : '✔';
      console.log(`${mark} ${String(scenario.id).padStart(2)}. ${scenario.name} (${seconds}s)`);
      for (const problem of problems) console.log(`      ${problem}`);
      if (problems.length && list.length) {
        for (const message of list) console.log(`      消息: ${messageUrl(message)}`);
      }
      results.push({ scenario, problems });
    }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => null);
  }
  return results;
}
