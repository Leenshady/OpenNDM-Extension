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
<!-- 撑出竖直滚动条：面板若按 innerWidth 定位就会被滚动条（Windows 占位式细滚动条同样占位）盖住。
     Force a vertical scrollbar: a panel placed by innerWidth would sit under the bar,
     and Windows' reserved-region scrollbars take space too. -->
<div style="height:3000px"></div>
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
/* 面板交互：真实鼠标拖动，断言自由定位与贴边隐藏                                       */
/* Real mouse drags that assert free placement and edge docking of the panel.   */
/* -------------------------------------------------------------------------- */

// 与 catcher.js 的 DOCK_PEEK / DOCK_SIZE 对应：贴边圆球沉进边缘后屏内还剩多宽。
// Mirrors DOCK_PEEK / DOCK_SIZE in catcher.js: the ball is DOCK_SIZE wide, PEEK stays on screen.
const PEEK = 30;
const BALL = 40;
// 与 catcher.js 的 PILL_FLOAT_W / HOVER_MARGIN 对应：探出后胶囊占据的宽度，与迟滞带宽度。
// Mirrors PILL_FLOAT_W / HOVER_MARGIN: how wide the pill is once slid out, and the dead band.
const PILL_W = 96;
const HYSTERESIS = 8;
const SIDE_CN = { left: '左', right: '右', top: '上', bottom: '下' };

// 定位基准永远是胶囊：host 的 data-* 给原点，卡片作为浮层的矩形单独读。
// The pill is always the reference: the host's data-* carry its origin, the card rect is read
// separately because it is a popover offset from that origin.
function readPanel(evaluate) {
  return evaluate(`(() => {
    const host = document.getElementById('ndm-media-panel-host');
    if (!host || host.style.display === 'none') return null;
    const root = host.shadowRoot;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box && box.width && box.height
        ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          top: Math.round(box.top),
          right: Math.round(box.right),
          bottom: Math.round(box.bottom),
          width: Math.round(box.width),
          height: Math.round(box.height)
        }
        : null;
    };
    const center = (element) => {
      const box = element?.getBoundingClientRect();
      return box && box.width ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null;
    };
    const shown = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const pill = root.querySelector('.launcher');
    const card = root.querySelector('.panel');
    const docked = root.querySelector('.launcher.docked');
    const pillRect = rect(pill);
    // 贴边时真正还在屏内、还能点的那一块，是胶囊矩形与可视区的交集。
    // What is still on screen and clickable when docked: the pill's intersection with the viewport.
    let sliver = null;
    if (docked && pillRect) {
      const left = Math.max(pillRect.x, 0);
      const top = Math.max(pillRect.y, 0);
      const right = Math.min(pillRect.right, width);
      const bottom = Math.min(pillRect.bottom, height);
      if (right - left >= 1 && bottom - top >= 1) {
        sliver = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
      }
    }
    // 拖动起点：卡片抓标题栏，胶囊抓自身；两者都取可见矩形，不受 transform 影响。
    // Grab points: the card's title bar or the pill itself, both from the visible rect.
    const grab = (element) => {
      const box = element?.getBoundingClientRect();
      return box && box.width
        ? {
          x: Math.round(box.x + Math.min(160, box.width / 2)),
          y: Math.round(box.y + Math.min(20, box.height / 2))
        }
        : null;
    };
    return {
      dock: host.dataset.dock || '',
      left: Number(host.dataset.left),
      top: Number(host.dataset.top),
      // offsetWidth/Height 不含沉入 transform，是「圆球收成 40px 没有」的判据。
      // offsetWidth/Height ignore the park transform, so they prove the ball really shrank.
      boxW: pill?.offsetWidth || 0,
      boxH: pill?.offsetHeight || 0,
      open: shown(card),
      pillShown: shown(pill),
      docked: Boolean(docked),
      sliver,
      pillRect,
      card: rect(card),
      icon: rect(pill?.querySelector('svg')),
      badge: rect(root.querySelector('.launcher-count')),
      count: root.querySelector('.launcher-count')?.textContent?.trim() || '',
      pill: center(pill),
      minimize: center(root.querySelector('.minimize')),
      grabCard: grab(card),
      grabPill: grab(pill),
      width,
      height,
      // 滚动条占掉的宽度：>0 时按 innerWidth 定位就会被盖住。
      // Width eaten by the scrollbar; when it is > 0, placing by innerWidth gets covered.
      barGap: window.innerWidth - width,
      outerWidth: window.innerWidth,
      outerHeight: window.innerHeight
    };
  })()`);
}

// 用真鼠标事件点面板里的按钮，验证按钮的 click 没有被拖动逻辑吞掉。
// Real mouse clicks, proving drag handling did not swallow the buttons' click events.
async function mouse(cdp, sessionId, type, x, y, button = 'left') {
  // clickCount 必须给：按下/抬起没有它就不会合成 click 事件，面板点不开。
  // Press/release need clickCount or Chrome synthesises no click at all.
  const params = { type, x: Math.round(x), y: Math.round(y), button };
  if (type === 'mousePressed' || type === 'mouseReleased') params.clickCount = 1;
  await cdp.send('Input.dispatchMouseEvent', params, sessionId);
}

async function clickPanel(evaluate, cdp, sessionId, selector) {
  const value = (await readPanel(evaluate)).value;
  const point = value?.[selector === '.minimize' ? 'minimize' : 'pill'];
  if (!point) return false;
  await mouse(cdp, sessionId, 'mousePressed', point.x, point.y);
  await mouse(cdp, sessionId, 'mouseReleased', point.x, point.y);
  return true;
}

// 贴边时可见的那一条就是元素本身，点它应当脱离贴边而不是点穿到页面。
// 但要先悬停把圆球请回屏内再点：按下与抬起之间元素还在动（探出有 .22s 补间），
// Chrome 就不会把这两个事件合成 click——真实用户也是"移过去、等它出来、再点"。
// The sliver left on screen is the element itself, and clicking it must release the dock.
// Hover first, though: while the ball is still sliding out, press and release land on boxes that
// no longer coincide, so Chrome never synthesises the click — the same thing a real user does by
// moving in, waiting for it to come out, then clicking.
async function clickSliver(evaluate, cdp, sessionId) {
  const sleepShort = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  const parked = (await readPillAtRest(evaluate, sleepShort, 'pill'));
  if (!parked?.sliver) return false;
  // 先把指针放到胶囊之外：刚收起/刚吸附的胶囊会解除悬停待命，指针要离开一次再回来才请得出它。
  // Park the pointer away first: a pill that just folded or snapped is disarmed until the pointer
  // leaves its zone and returns, which is exactly what a real user does before hovering in.
  await mouse(cdp, sessionId, 'mouseMoved', Math.round(parked.width * 0.3), 6, 'none');
  await sleepShort(200);
  await mouse(cdp, sessionId, 'mouseMoved', parked.sliver.x, parked.sliver.y, 'none');
  await sleepShort(400);
  const peeked = await readPillAtRest(evaluate, sleepShort, 'pill');
  // 探出就按整颗胶囊，没探出就按屏内露出的那一条——两种都在元素本体上。
  // Press on the whole pill when it slid out, on the visible band when it did not; both are the element.
  const point = peeked ? (peeked.docked ? peeked.sliver : peeked.grabPill) : parked.sliver;
  await mouse(cdp, sessionId, 'mousePressed', point.x, point.y);
  await mouse(cdp, sessionId, 'mouseReleased', point.x, point.y);
  return true;
}

// 等补间走完再量：贴边/探出/收成圆球各有 ~.22s 的 width 与 transform 动画，动画中途读到的矩形
// 既不是沉入后的、也不是屏内可见的那一块，按它按下指针就会落到网页上。
// Measure only at rest: the fold, the slide-out and the shrink all tween width and transform for
// ~.22s. A rect read mid-flight is neither the parked box nor the visible band, so pressing at a
// point taken from it lands on the page.
async function readPillAtRest(evaluate, sleep, target) {
  let value = (await readPanel(evaluate)).value;
  for (let i = 0; i < 6 && value; i += 1) {
    await sleep(120);
    const next = (await readPanel(evaluate)).value;
    if (!next) return value;
    const key = target === 'card' ? 'card' : 'pillRect';
    const same = JSON.stringify(next[key]) === JSON.stringify(value[key]);
    value = next;
    if (same) break;
  }
  return value;
}

// 拖动：target 是 'card'（抓标题栏）还是 'pill'（抓胶囊自身），终点用视口坐标。
// Drag by the card's title bar or by the pill itself; the destination is in client-box pixels.
async function dragPanel(evaluate, cdp, sessionId, target, toX, toY) {
  const before = await readPillAtRest(evaluate, (ms) => new Promise((r) => setTimeout(r, ms)), target);
  // 贴边时胶囊的矩形有一半在屏外，抓它的几何中心会按到网页上：抓屏内还露着的那一条。
  // Half of a docked pill's rect is off screen, so its geometric centre can be a click on the
  // page — grab the band that is still visible instead.
  const from = before?.[target === 'pill' ? (before.docked ? 'sliver' : 'grabPill') : 'grabCard'];
  if (!from) return null;
  await mouse(cdp, sessionId, 'mousePressed', from.x, from.y);
  for (let i = 1; i <= 8; i += 1) {
    await mouse(cdp, sessionId, 'mouseMoved', from.x + ((toX - from.x) * i) / 8, from.y + ((toY - from.y) * i) / 8);
  }
  await mouse(cdp, sessionId, 'mouseReleased', toX, toY);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  // 松手点往往还在元素上，悬停会让它探回屏内，测不到"已沉入边缘"——把指针挪开再读。
  // The release point usually still hovers the element, which peeks it back on screen; move the
  // pointer away so the parked state is what gets measured.
  await mouse(cdp, sessionId, 'mouseMoved', Math.round(before.width * 0.92), 6, 'none');
  // 位置(left/top)与沉入(transform)、收成圆球的宽度各有 ~.22s 补间，等它们都走完再量。
  // The left/top snap, the park transform and the ball width all tween for ~.22s; measure at rest.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 450));
  return (await readPanel(evaluate)).value;
}

/**
 * 三态互斥：折叠态只有胶囊（图标 + 数量徽标）、展开态只有卡片、贴边态只有收成圆球的胶囊。
 * 真鼠标跑一遍：展开/收起不跳位 → 拖卡片到右边缘自动收起并贴边 → 悬停滑出 → 点它脱离并展开
 * → 拖胶囊到左/下边缘 → 重新加载后位置与贴边方向从 chrome.storage 恢复。
 * Three mutually exclusive states: collapsed is the pill alone (icon + count), expanded is the
 * card alone, docked is the pill shrunk to a ball. Real mouse input walks the whole model: open
 * and fold without shifting, drag the card onto the right edge to fold and park it, hover it back
 * out, click it to release and expand, drag the pill to the left and bottom edges, then reload
 * and check the placement comes back from chrome.storage.
 */
async function verifyPanelPlacement({ evaluate, cdp, sessionId, waitFor, sleep, videoUrl }) {
  const problems = [];
  const state = async () => (await readPanel(evaluate)).value;
  const waitUntil = (test, message) => waitFor(async () => {
    const value = await state();
    return value && test(value) ? value : null;
  }, 6000, 200).then((value) => {
    if (!value) problems.push(message);
    return value;
  });
  const midX = (box) => (box.x + box.right) / 2;
  const midY = (box) => (box.y + box.bottom) / 2;

  // 展开的卡片必须整个落在"不含滚动条"的可视区里，否则会被滚动条或窗口边切掉。
  // The open card must sit wholly inside the client box, or a scrollbar or the window edge cuts it.
  const assertCardInside = (value, label) => {
    const box = value.card;
    if (!box) {
      problems.push(`${label}读不到卡片矩形 / ${label}: the card rect was unreadable`);
      return;
    }
    if (box.x < -1 || box.right > value.width + 1 || box.y < -1 || box.bottom > value.height + 1) {
      problems.push(`${label}卡片越出可视区：(${box.x},${box.y})→(${box.right},${box.bottom}) 可视区=${value.width}x${value.height}`);
    }
  };

  // 贴边态唯一可见的东西是圆球屏内那 PEEK 宽的一条：图标必须整个在里面，还要在球心。
  // In the docked state the only thing anyone sees is the PEEK-wide band the ball leaves on
  // screen — the icon has to fit inside it and stay centred, or the ball reads as clipped.
  const assertBall = (value, side) => {
    const label = SIDE_CN[side];
    if (value.dock !== side) {
      problems.push(`应吸附到${label}边缘：dock=${value.dock || '（未贴边）'}`);
      return;
    }
    if (!value.docked) problems.push(`贴${label}边时胶囊没收成圆球 / the pill did not morph into a ball on the ${side} edge`);
    if (value.open) problems.push(`贴${label}边时卡片不该还展开 / the card stayed open on the ${side} edge`);
    if (value.card) problems.push(`贴${label}边时卡片不该还占着布局 / the card was still laid out on the ${side} edge`);
    if (value.boxW !== BALL || value.boxH !== BALL) {
      problems.push(`贴边胶囊应是 ${BALL}px 圆球：实测 ${value.boxW}x${value.boxH}`);
    }
    const icon = value.icon;
    const ball = value.pillRect;
    if (!icon || !ball) {
      problems.push('读不到贴边圆球的几何 / the docked ball was unreadable');
      return;
    }
    const onScreen = {
      left: () => Math.abs(ball.right - PEEK) <= 1 && icon.x >= -1 && icon.right <= PEEK + 1,
      right: () => Math.abs(ball.x - (value.width - PEEK)) <= 1
        && icon.x >= value.width - PEEK - 1 && icon.right <= value.width + 1,
      top: () => Math.abs(ball.bottom - PEEK) <= 1 && icon.y >= -1 && icon.bottom <= PEEK + 1,
      bottom: () => Math.abs(ball.top - (value.height - PEEK)) <= 1
        && icon.y >= value.height - PEEK - 1 && icon.bottom <= value.height + 1
    }[side];
    if (!onScreen()) {
      problems.push(`贴${label}边只应露出 ${PEEK}px 且图标完整在内：球=${JSON.stringify(ball)} 图标=${JSON.stringify(icon)} 可视区=${value.width}x${value.height}`);
    }
    if (Math.abs(midX(icon) - midX(ball)) > 1.5 || Math.abs(midY(icon) - midY(ball)) > 1.5) {
      problems.push(`贴${label}边时图标不在圆球正中：图标(${midX(icon)},${midY(icon)}) 球(${midX(ball)},${midY(ball)})`);
    }
  };

  // ① 折叠态：只有胶囊，图标 + 数量徽标，且不被滚动条盖住。
  // 1) Collapsed: the pill alone — icon plus count — clear of the scrollbar.
  const start = await waitUntil((value) => !value.open && value.pillShown && !value.docked && value.pillRect,
    '媒体胶囊未以折叠态出现 / the media pill never appeared collapsed');
  if (!start) return problems;
  if (start.card) problems.push('折叠态不该有卡片矩形 / the card was laid out while collapsed');
  if (!start.icon || !start.badge) problems.push('折叠胶囊缺少图标或数量徽标 / the collapsed pill lost its icon or count badge');
  if (!Number(start.count)) problems.push(`折叠胶囊的计数徽标没有数字：count="${start.count}"`);
  if (start.pillRect.right > start.width + 1) {
    problems.push(`胶囊被滚动条盖住：右边=${start.pillRect.right} 可视宽=${start.width}（innerWidth=${start.outerWidth}）`);
  }
  if (start.icon && Math.abs(midY(start.icon) - midY(start.pillRect)) > 1.5) {
    problems.push(`折叠胶囊的图标没垂直居中：图标中线=${midY(start.icon)} 胶囊中线=${midY(start.pillRect)}`);
  }

  // ② 点胶囊：只展开卡片，胶囊让位（visibility 隐藏，仍是定位基准）。
  // 2) Clicking the pill opens the card only; the pill steps aside via visibility, still the anchor.
  if (!await clickPanel(evaluate, cdp, sessionId, '.launcher')) {
    return [...problems, '媒体胶囊不可点 / the media pill was not clickable'];
  }
  const expanded = await waitUntil((value) => value.open && !value.pillShown && value.dock === '',
    '点胶囊没能只展开卡片 / clicking the pill did not open the card on its own');
  if (!expanded) return problems;
  assertCardInside(expanded, '展开态');

  // ③ 面板内收起：原点（胶囊位置）不许动，动了的就只会是尺寸——否则胶囊会跳位。
  // 3) Folding from inside the card must not move the origin, only the size, or the pill jumps.
  await clickPanel(evaluate, cdp, sessionId, '.minimize');
  const folded = await waitUntil((value) => !value.open && value.pillShown,
    '点收起图标没能折叠面板 / the card\'s collapse icon did not fold the panel');
  if (!folded) return problems;
  if (folded.left !== expanded.left || folded.top !== expanded.top) {
    problems.push(`收起后定位原点漂移：(${expanded.left},${expanded.top})→(${folded.left},${folded.top})`);
  }

  // ④ 拖卡片到右边缘：自动收起并贴边，圆球只露 PEEK，图标完整且居中。
  // 4) Dragging the card onto the right edge folds it and parks the ball: PEEK stays visible,
  // with the whole icon inside it, centred.
  await clickPanel(evaluate, cdp, sessionId, '.launcher');
  const openAgain = await waitUntil((value) => value.open && value.card,
    '折叠后无法再次展开 / the pill did not reopen the card');
  if (!openAgain) return problems;
  const rightBall = await dragPanel(evaluate, cdp, sessionId, 'card', openAgain.width - 1, openAgain.grabCard.y);
  if (!rightBall) {
    problems.push('拖卡片到右边缘后面板消失 / the panel vanished after the right-edge card drag');
    return problems;
  }
  assertBall(rightBall, 'right');

  // ⑤ 悬停圆球：整颗滑回屏内；指针移开：再沉回边上。
  // 5) Hovering the ball slides the whole thing back in; leaving parks it again.
  if (!rightBall.sliver) {
    problems.push('贴右边时找不到可悬停的圆球 / the right-docked ball could not be hovered');
  } else {
    await mouse(cdp, sessionId, 'mouseMoved', rightBall.sliver.x, rightBall.sliver.y, 'none');
    await sleep(400);
    const peeked = await state();
    if (!peeked || peeked.docked) {
      problems.push('悬停圆球未滑回屏内 / hovering the ball did not slide it back on screen');
    } else if (peeked.pillRect && (peeked.pillRect.x < -1 || peeked.pillRect.right > peeked.width + 1)) {
      problems.push(`悬停后圆球没完全回到屏内：${JSON.stringify(peeked.pillRect)} 可视宽=${peeked.width}`);
    }
    if (peeked) {
      await mouse(cdp, sessionId, 'mouseMoved', Math.round(peeked.width * 0.92), 6, 'none');
      await sleep(400);
      const reparked = await state();
      if (reparked && !reparked.docked) {
        problems.push('指针移开后圆球没收回边上 / the ball did not park again once the pointer left');
      }
    }
  }

  // ⑥ 点那一条：先脱离贴边，再展开卡片——贴边与展开互斥。
  // 6) Clicking it releases the dock and then expands: the two states are mutually exclusive.
  if (!await clickSliver(evaluate, cdp, sessionId)) {
    problems.push('贴右边时找不到可见的那一块 / nothing of the right-docked ball was clickable');
  }
  const reopened = await waitUntil((value) => value.open && value.dock === '' && !value.pillShown,
    '点贴边圆球没能脱离并展开 / clicking the docked ball neither released the dock nor opened the card');
  if (!reopened) return problems;
  assertCardInside(reopened, '脱离贴边后');

  // ⑦ 拖胶囊本身到左边缘：同样只露 PEEK，图标完整。
  // 7) Dragging the pill itself to the left edge: same PEEK of ball, whole icon inside it.
  await clickPanel(evaluate, cdp, sessionId, '.minimize');
  const foldedPill = await waitUntil((value) => !value.open && value.pillShown && value.grabPill,
    '第二次收起失败 / the card did not fold the second time');
  if (!foldedPill) return problems;
  const leftBall = await dragPanel(evaluate, cdp, sessionId, 'pill', 0, foldedPill.grabPill.y);
  if (!leftBall) {
    problems.push('拖胶囊到左边缘后胶囊消失 / the pill vanished after the left-edge drag');
  } else {
    assertBall(leftBall, 'left');
  }

  if (!await clickSliver(evaluate, cdp, sessionId)) {
    problems.push('贴左边时找不到可见的那一块 / nothing of the left-docked ball was clickable');
  }
  const fromLeft = await waitUntil((value) => value.open && value.dock === '' && value.card,
    '贴左圆球没能展开卡片 / the left-docked ball did not expand the card');
  if (!fromLeft) return problems;

  // ⑧ 卡片拖到下边缘：贴下边，圆球只露 PEEK 高。
  // 8) Dragging the card to the bottom edge parks the ball with PEEK px of height showing.
  const bottomBall = await dragPanel(evaluate, cdp, sessionId, 'card',
    Math.round(fromLeft.width * 0.5), fromLeft.height - 1);
  if (!bottomBall) {
    problems.push('拖卡片到下边缘后面板消失 / the panel vanished after the bottom-edge card drag');
  } else {
    assertBall(bottomBall, 'bottom');
  }

  // ⑨ 悬停判定的两块矩形都只由贴边状态算出，与胶囊此刻的位置无关：
  //    进——指针要落到屏内露出的那一条（球 + HOVER_MARGIN 容差）；落在"探出后才有"的那半截上
  //        不许提前弹出（旧判据按整颗胶囊算，离边还有几十像素就弹了）；
  //    出——要彻底走出探出后的整颗胶囊再放宽 HOVER_MARGIN 才收回；在它身上逛、原地 1px 抖动都不翻。
  //    旧实现挂在胶囊自身的 pointerenter/pointerleave 上：胶囊一动命中就重算，弹出与收起互相触发。
  // 9) Two rectangles, both pure functions of the docked state. Entering requires the pointer on
  // the band the parked ball actually leaves on screen (+ HOVER_MARGIN of slack); landing on the
  // half that only exists once slid out must NOT peek — the old trigger used the slid-out pill, so
  // the ball popped out while the pointer was still tens of pixels from the edge. Leaving needs
  // the pointer beyond the whole slid-out pill by HOVER_MARGIN; wandering over it and 1 px tremor
  // flip nothing. The old wiring keyed on the pill's own pointerenter/pointerleave, so each
  // slide-out re-ran the hit test and the two states triggered each other forever.
  if (bottomBall) {
    // 贴下边：沉住时屏内只剩 [left, left+40] × [height-30, height]；探出后整颗是 [left, left+96] ×
    // [height-40, height]。差集就是"探出后才有"的那半截。
    const bandTop = bottomBall.height - PEEK;
    const keepTop = bottomBall.height - BALL;
    const sample = async (x, y, wait = 260) => {
      await mouse(cdp, sessionId, 'mouseMoved', x, y, 'none');
      await sleep(wait);
      const value = await state();
      return value ? value.docked : null;
    };
    // 探出的胶囊身上、露出那一条之外：收起时不该弹，探出时不该收。
    const onlyWhenPeeked = {
      x: Math.min(Math.round(bottomBall.left + PILL_W - 16), bottomBall.width - 2),
      y: Math.round(bandTop + PEEK / 2)
    };
    const onBall = { x: Math.round(bottomBall.left + BALL / 2), y: Math.round(bandTop + PEEK / 2) };
    // 走出整颗胶囊、但只走出不超过 HOVER_MARGIN 的一半：仍应保持探出（迟滞带）。
    // Past the slid-out pill, but by less than HOVER_MARGIN: still peeked.
    const inDeadBand = { x: onlyWhenPeeked.x, y: keepTop - Math.round(HYSTERESIS / 2) };
    const fullyOut = { x: Math.max(2, Math.round(bottomBall.left - 40)), y: keepTop - 60 };

    await sample(fullyOut.x, fullyOut.y, 300);
    if (await sample(onlyWhenPeeked.x, onlyWhenPeeked.y) !== true) {
      problems.push('指针还没到边就提前弹出：这一点只在探出后才属于胶囊 '
        + `(${onlyWhenPeeked.x},${onlyWhenPeeked.y}) 球=${JSON.stringify(bottomBall.pillRect)}`);
    }
    if (await sample(onBall.x, onBall.y) !== false) {
      problems.push('指针落到露出的那一条上没滑回屏内 / the ball did not slide out on its visible band');
    }
    if (await sample(onlyWhenPeeked.x, onlyWhenPeeked.y) !== false) {
      problems.push('指针还在探出的胶囊上就收回贴边 / the ball parked while the pointer was still over it');
    }
    const jitter = [];
    for (let i = 0; i < 5; i += 1) {
      jitter.push(await sample(onlyWhenPeeked.x + (i % 2 ? 1 : -1), onlyWhenPeeked.y + (i % 2 ? -1 : 1), 120));
    }
    if (jitter.some((docked) => docked !== false)) {
      problems.push(`探出后指针抖动引起状态翻转：${JSON.stringify(jitter)}`);
    }
    if (await sample(inDeadBand.x, inDeadBand.y) !== false) {
      problems.push('指针还在迟滞带里就收回贴边 / the ball parked while the pointer was still in the dead band');
    }
    if (await sample(fullyOut.x, fullyOut.y) !== true) {
      problems.push('指针彻底离开后没有收回贴边 / the ball did not park once the pointer left the zone');
    }
    // 指针不动时连续采样：状态必须恒定，否则就是自己跟自己循环。
    // Sampling with the pointer held still: the state must be constant, or it loops on its own.
    const still = [];
    for (let i = 0; i < 4; i += 1) {
      await sleep(200);
      const value = await state();
      still.push(value ? value.docked : null);
    }
    if (still.some((docked) => docked !== true)) {
      problems.push(`静止悬停时贴边状态反复：${JSON.stringify(still)}`);
    }
  }

  // ⑩ 重新加载：位置与贴边方向应来自 chrome.storage，而不是回到默认右下角。
  // 10) After reload the placement must come from chrome.storage, not the default bottom-right.
  await cdp.send('Page.navigate', { url: `${videoUrl}?r=persist` }, sessionId);
  await sleep(600);
  const restored = await waitFor(async () => {
    const value = await state();
    return value && value.dock === 'bottom' ? value : null;
  }, 6000, 200);
  if (!restored) {
    problems.push(`重新加载后未恢复贴边：期望 bottom，实际 ${JSON.stringify(await readPanel(evaluate))}`);
  } else if (bottomBall) {
    // 贴边轴由停靠规则钉在视口边上，比较未变换的 top+boxH；自由轴直接比 left。
    // The docked axis is pinned to the edge, so compare the untransformed bottom (top + boxH);
    // compare left freehand.
    const before = bottomBall.top + bottomBall.boxH;
    const after = restored.top + restored.boxH;
    if (!bottomBall.boxH || !restored.boxH) {
      problems.push('重新加载前后读不到圆球尺寸 / the ball was unreadable across the reload');
    } else if (Math.abs(after - before) > 2 || Math.abs(restored.left - bottomBall.left) > 2) {
      problems.push(`重新加载后位置漂移：底边 ${before}→${after}，left ${bottomBall.left}→${restored.left}`);
    }
  }

  // ⑪ 点击面板以外：展开的卡片自动收回成胶囊，并回到点开它时那条边上；点卡片内部不算"外面"。
  // 11) Clicking anywhere else on the page folds the open card back into the pill — and onto the
  // edge it was opened from. A click inside the card is not "elsewhere".
  if (!await clickSliver(evaluate, cdp, sessionId)) {
    problems.push('重新加载后找不到可点的贴边圆球 / the docked ball was unclickable after the reload');
  }
  const openedOutside = await waitUntil((value) => value.open && value.card,
    '点贴边圆球没能展开卡片（点击外部检测） / the docked ball did not open the card for the outside-click check');
  if (openedOutside) {
    const cardBox = openedOutside.card;
    const insideCard = {
      x: Math.round(cardBox.x + Math.min(60, cardBox.width - 40)),
      y: Math.round(cardBox.y + 12)
    };
    await mouse(cdp, sessionId, 'mousePressed', insideCard.x, insideCard.y);
    await mouse(cdp, sessionId, 'mouseReleased', insideCard.x, insideCard.y);
    await sleep(320);
    if (!(await state())?.open) {
      problems.push('点卡片内部把面板收起了 / clicking inside the card folded the panel');
    }
    const elsewhere = {
      x: Math.round(openedOutside.width * 0.25),
      y: Math.round(openedOutside.height * 0.25)
    };
    await mouse(cdp, sessionId, 'mousePressed', elsewhere.x, elsewhere.y);
    await mouse(cdp, sessionId, 'mouseReleased', elsewhere.x, elsewhere.y);
    const foldedOutside = await waitUntil((value) => !value.open && value.pillShown && value.docked,
      '点击网页其他地方后卡片没收回成胶囊 / the card stayed open after clicking elsewhere on the page');
    if (foldedOutside) {
      if (foldedOutside.dock !== 'bottom') {
        problems.push(`点击外部收回后没回到下边缘：dock=${foldedOutside.dock || '（未贴边）'}`);
      }
      if (!await clickSliver(evaluate, cdp, sessionId)) {
        problems.push('点击外部收回后找不到可点的圆球 / the re-parked ball was unclickable');
      }
      const reopenedOutside = await waitUntil((value) => value.open && value.dock === '',
        '收回后点圆球没能再展开 / the ball did not reopen the card after the outside click');
      if (reopenedOutside) {
        // ⑫ 用户报的那条：鼠标指着贴边胶囊点开面板，再点 ⌄ 收起，胶囊必须重新贴回同一条边，
        // 而不是停在刚脱离时的位置。位置也要对上（底边钉住、自由轴不变）。
        // 12) The reported case: pointer on the docked pill, open the card, fold it with ⌄ — the pill
        // must go back onto that same edge, not stay where releasing the dock left it, and at the
        // same place (pinned bottom edge, free axis unchanged).
        await clickPanel(evaluate, cdp, sessionId, '.minimize');
        const foldedAgain = await waitUntil((value) => !value.open && value.pillShown && value.docked,
          '点 ⌄ 收起后胶囊没有重新贴边 / folding with ⌄ left the pill off the edge');
        if (foldedAgain) {
          if (foldedAgain.dock !== 'bottom') {
            problems.push(`收起后贴到了别的边：dock=${foldedAgain.dock || '（未贴边）'}`);
          }
          if (Math.abs(foldedAgain.top + foldedAgain.boxH - (restored ? restored.top + restored.boxH : foldedAgain.top)) > 2) {
            problems.push(`收起后底边位置漂移：${foldedAgain.top + foldedAgain.boxH} vs ${restored ? restored.top + restored.boxH : '未知'}`);
          }
          if (restored && Math.abs(foldedAgain.left - restored.left) > 2) {
            problems.push(`收起后自由轴漂移：left ${restored.left}→${foldedAgain.left}`);
          }
        }
      }
    }
  }
  return problems;
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
    },
    {
      id: 15, name: '媒体面板三态互斥：折叠胶囊、展开卡片、贴边圆球，悬停不循环、点页面其他地方收起、位置可恢复',
      direct: `${base}/video.html`, settle: 3000,
      path: null, count: [0, 0], whole: true,
      ui: (helpers) => verifyPanelPlacement({ ...helpers, videoUrl: `${base}/video.html` })
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
      // UI 场景用真实鼠标事件驱动页面，断言完之后再用 settle 检查有没有误发消息。
      // UI scenarios drive real mouse events; the settle window then checks that nothing was sent.
      if (scenario.ui) {
        try {
          problems.push(...(await scenario.ui({ evaluate, cdp, sessionId, sleep, waitFor })) || []);
        } catch (error) {
          problems.push(`界面断言异常 / ui assertion threw: ${error.message}`);
        }
      }
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
