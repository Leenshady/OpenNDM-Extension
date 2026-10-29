/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 网页冒烟测试：用临时真浏览器加载扩展，打开一批免登录的国内常用网站，
 * 观察扩展是否会向 NDM 发送任何"预期之外"的下载。
 *
 * Web smoke test: load the extension in a throwaway browser profile, visit a list of
 * popular Chinese sites that need no login, and report anything the extension would hand to
 * NDM. A fake NDM WebSocket server records the messages, so nothing is really downloaded.
 *
 * 用法 / Usage:
 *   node scripts/web-test.mjs [--browser chrome|edge] [--seconds 8] [--headed] [--filter 关键词]
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectFiles } from './package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 免登录即可浏览的常用站点 / Popular sites that are browsable without logging in.
const SITES = [
  ['百度', 'https://www.baidu.com/'],
  ['新浪', 'https://www.sina.com.cn/'],
  ['网易', 'https://www.163.com/'],
  ['腾讯网', 'https://www.qq.com/'],
  ['知乎', 'https://www.zhihu.com/'],
  ['豆瓣', 'https://www.douban.com/'],
  ['36氪', 'https://www.36kr.com/'],
  ['CSDN', 'https://www.csdn.net/'],
  ['博客园', 'https://www.cnblogs.com/'],
  ['哔哩哔哩', 'https://www.bilibili.com/'],
  ['爱奇艺', 'https://www.iqiyi.com/'],
  ['京东', 'https://www.jd.com/']
];

const BROWSERS = {
  chrome: [
    join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
  ].filter(Boolean),
  edge: [
    join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe')
  ].filter(Boolean)
};

/* -------------------------------------------------------------------------- */
/* 参数                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = { browser: 'chrome', seconds: 8, headed: false, filter: '', keep: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--browser' || arg === '-b') options.browser = argv[++i] || 'chrome';
    else if (arg === '--seconds' || arg === '-s') options.seconds = Math.max(2, Number(argv[++i]) || 8);
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--filter' || arg === '-f') options.filter = String(argv[++i] || '');
    else if (arg === '--keep-profile') options.keep = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/web-test.mjs [--browser chrome|edge] [--seconds 8] [--headed] [--filter 关键词] [--keep-profile] [--verbose]');
      process.exit(0);
    } else {
      console.error(`未知参数 / unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* 假 NDM：只记录 WebSocket 消息，不产生任何下载                                */
/* -------------------------------------------------------------------------- */

function createFakeNdm() {
  const messages = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    response.writeHead(426, { 'Content-Type': 'text/plain' });
    response.end('WebSocket upgrade required');
  });

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      'Sec-WebSocket-Protocol: neatextension.v1',
      '', ''
    ].join('\r\n'));
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) {
          const mask = buffer.subarray(maskOffset, maskOffset + 4);
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x1) {
          messages.push({ at: Date.now(), text: payload.toString('utf8') });
        } else if (opcode === 0x8) {
          socket.end();
          return;
        } else if (opcode === 0x9) {
          socket.write(Buffer.from([0x8a, payload.length, ...payload]));
        }
      }
    });
  });

  return {
    server,
    messages,
    sockets,
    listen(port) {
      return new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, '127.0.0.1', () => resolvePromise(server.address().port));
      });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
  };
}

/* -------------------------------------------------------------------------- */
/* 极简 CDP 客户端                                                             */
/* -------------------------------------------------------------------------- */

class Cdp {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolvePromise, rejectPromise) => {
      this.ws.addEventListener('open', () => resolvePromise());
      this.ws.addEventListener('error', () => rejectPromise(new Error('CDP 连接失败 / CDP connection failed')));
    });
    this.ws.addEventListener('message', (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!payload.id) return;
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(`${pending.method}: ${payload.error.message || 'CDP error'}`));
      else pending.resolve(payload.result);
    });
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, method });
      this.ws.send(JSON.stringify(message));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 忽略关闭错误 / Ignore close errors.
    }
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(check, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* 浏览器                                                                      */
/* -------------------------------------------------------------------------- */

function findBrowser(name) {
  const candidates = BROWSERS[name] || [];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

async function launchBrowser(executable, profileDir) {
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--window-size=1400,900',
    'about:blank'
  ];
  if (!options.headed) args.unshift('--headless=new');

  const child = spawn(executable, args, { stdio: 'ignore' });
  const portFile = join(profileDir, 'DevToolsActivePort');
  const port = await waitFor(async () => {
    try {
      const text = await readFile(portFile, 'utf8');
      const value = Number(text.split(/\r?\n/, 1)[0]);
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }, 20_000, 200);
  if (!port) {
    child.kill();
    fail('浏览器没有打开调试端口 / browser did not open the DevTools port');
  }
  return { child, port };
}

async function readExtensionId(profileDir) {
  // 从 Preferences 里找出刚加载的解压扩展 / Find the unpacked extension id in Preferences.
  const preferencesPath = join(profileDir, 'Default', 'Preferences');
  const preferences = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(preferencesPath, 'utf8'));
    } catch {
      return null;
    }
  }, 15_000, 300);
  const settings = preferences?.extensions?.settings || {};
  const normalizedRoot = root.replace(/\\/g, '/').toLowerCase();
  for (const [id, value] of Object.entries(settings)) {
    const path = String(value?.path || '').replace(/\\/g, '/').toLowerCase();
    if (path === normalizedRoot) return id;
  }
  return '';
}

/**
 * 复制一份扩展并把默认 NDM 端口改成假 NDM 的端口，避免测试碰到真正的 NDM。
 * Copy the extension and point its default NDM port at the fake server, so the real NDM is never touched.
 */
async function prepareExtension(port) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'ndm-ext-'));
  for (const file of collectFiles(manifest)) {
    const destination = join(directory, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, file), destination);
  }
  const constantsPath = join(directory, 'src/lib/constants.js');
  const source = await readFile(constantsPath, 'utf8');
  await writeFile(constantsPath, source.replace(/ndmPort:\s*\d+/, `ndmPort: ${port}`));
  return directory;
}

/* -------------------------------------------------------------------------- */
/* 报告                                                                        */
/* -------------------------------------------------------------------------- */

function summarize(message) {
  const lines = String(message.text || '').split('\r\n');
  const field = (prefix) => {
    const line = lines.find((item) => item.startsWith(prefix));
    return line ? line.slice(prefix.length) : '';
  };
  return {
    url: field('2:'),
    kind: field('6:') || 'normal',
    filename: field('4:')
  };
}

async function main() {
  const executable = findBrowser(options.browser);
  if (!executable) fail(`找不到浏览器 / browser not found: ${options.browser}`);

  const profileDir = await mkdtemp(join(tmpdir(), 'ndm-web-test-'));
  const fakeNdm = createFakeNdm();
  const ndmPort = await fakeNdm.listen(0).catch((error) => fail(`无法启动假 NDM / cannot start fake NDM: ${error.message}`));
  const extensionDir = await prepareExtension(ndmPort);

  const { child, port } = await launchBrowser(executable, profileDir);
  let cdp = null;
  try {
    const version = await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        return response.ok ? response.json() : null;
      } catch {
        return null;
      }
    }, 20_000, 300);
    if (!version?.webSocketDebuggerUrl) fail('无法连接浏览器调试接口 / cannot reach the DevTools endpoint');

    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.ready;

    if (options.verbose) {
      const targets = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
      console.log('targets:', JSON.stringify(targets.targetInfos.map((info) => ({
        type: info.type,
        url: String(info.url).slice(0, 120)
      })), null, 2));
    }

    // 等待扩展加载：优先找本扩展的 Service Worker，其次调用 CDP 的 loadUnpacked
    // （Chrome 137+ 的品牌版会忽略 --load-extension，但 CDP 仍可加载）。
    // Wait for the extension: first look for our service worker, then fall back to the CDP
    // Extensions.loadUnpacked command (branded Chrome 137+ ignores --load-extension).
    const findOwnWorker = async () => {
      try {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const worker = targetInfos.find((info) => info.type === 'service_worker'
          && /^chrome-extension:\/\/[a-p]{32}\/src\/background\.js$/.test(String(info.url)));
        if (worker) return String(worker.url).slice('chrome-extension://'.length).split('/')[0];
      } catch {
        // 继续尝试 Preferences / Fall through to Preferences.
      }
      return readExtensionId(profileDir);
    };

    let extensionId = await waitFor(findOwnWorker, 3000, 300);
    if (!extensionId) {
      const loaded = await cdp.send('Extensions.loadUnpacked', { path: extensionDir })
        .catch((error) => ({ error: error.message }));
      if (options.verbose) console.log('loadUnpacked:', JSON.stringify(loaded));
      extensionId = loaded?.id || '';
      if (!extensionId) {
        fail(`无法加载扩展 / cannot load the extension（${loaded?.error || 'loadUnpacked unavailable'}）`);
      }
    }
    if (options.verbose) console.log('extension id:', extensionId);

    // 打开一个轻量页面唤醒 Service Worker，让它连接假 NDM。
    // Open a lightweight page to start the worker so it connects to the fake NDM.
    const warmup = await cdp.send('Target.createTarget', { url: 'https://www.baidu.com/robots.txt' }).catch(() => null);
    const connected = await waitFor(() => fakeNdm.sockets.size > 0, 10_000, 200);
    if (warmup?.targetId) await cdp.send('Target.closeTarget', { targetId: warmup.targetId }).catch(() => null);
    if (!connected) {
      fail('扩展没有连上假 NDM / the extension did not connect to the fake NDM');
    }

    console.log(`浏览器 / browser: ${executable}`);
    console.log(`扩展 ID / extension: ${extensionId}`);
    console.log(`假 NDM 端口 / fake NDM port: ${ndmPort}`);
    console.log(`每个站点停留 / per-site wait: ${options.seconds}s\n`);

    const sites = options.filter
      ? SITES.filter(([name, url]) => `${name} ${url}`.includes(options.filter))
      : SITES;
    if (!sites.length) fail(`没有匹配的站点 / no site matches "${options.filter}"`);

    const findings = [];
    const skipped = [];
    for (let index = 0; index < sites.length; index += 1) {
      const [name, url] = sites[index];
      const marker = fakeNdm.messages.length;
      const started = Date.now();
      const { targetId } = await cdp.send('Target.createTarget', { url });
      await sleep(options.seconds * 1000);

      // 确认页面真的加载了，避免把“没打开”误判成“没捕获”。
      // Confirm the page really loaded so a blank tab is not reported as a clean pass.
      let page = null;
      try {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const evaluated = await cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify({ href: location.href, title: document.title, resources: performance.getEntriesByType("resource").length })',
          returnByValue: true
        }, sessionId);
        page = JSON.parse(evaluated?.result?.value || '{}');
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => null);
      } catch {
        page = null;
      }
      await cdp.send('Target.closeTarget', { targetId }).catch(() => null);

      const captured = fakeNdm.messages.slice(marker).map(summarize);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const loaded = Boolean(page && !String(page.href || '').startsWith('chrome-error://') && Number(page.resources) > 0);
      const detail = loaded ? `${page.resources} 个资源 · ${String(page.title || '').slice(0, 24)}` : '页面未加载';

      if (!loaded) {
        skipped.push({ name, url, page });
        console.log(`⚠ ${String(index + 1).padStart(2)}/${sites.length} ${name.padEnd(6)} ${url}  ${detail} (${elapsed}s)`);
      } else if (!captured.length) {
        console.log(`✔ ${String(index + 1).padStart(2)}/${sites.length} ${name.padEnd(6)} ${url}  无捕获 (${elapsed}s, ${detail})`);
      } else {
        console.log(`✖ ${String(index + 1).padStart(2)}/${sites.length} ${name.padEnd(6)} ${url}  捕获 ${captured.length} 条 (${elapsed}s)`);
        for (const item of captured) findings.push({ name, url, ...item });
      }
    }

    console.log('');
    if (skipped.length) {
      console.log(`注意：${skipped.length} 个站点在无头模式下没有加载成功，未计入结论。`);
      console.log(`Note: ${skipped.length} site(s) did not load in headless mode and are excluded from the verdict.`);
      for (const item of skipped) console.log(`  ⚠ ${item.name} ${item.url}`);
      console.log('');
    }
    if (!findings.length) {
      console.log('结果：没有站点触发下载，符合“不下载预期以外文件”的预期。');
      console.log('Result: no unexpected download was triggered.');
      return 0;
    }

    console.log('结果：以下下载可能不是用户预期，请检查规则：');
    console.log('Result: the following downloads may be unexpected; review the rules:\n');
    for (const item of findings) {
      console.log(`- [${item.name}] ${item.kind} ${item.url || '(no url)'}`);
    }
    return 1;
  } finally {
    try {
      await cdp?.send('Browser.close');
    } catch {
      // 浏览器可能已经退出 / The browser may already be gone.
    }
    await fakeNdm.close();
    await sleep(500);
    if (!child.killed) child.kill();
    if (!options.keep) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => null);
      await rm(extensionDir, { recursive: true, force: true }).catch(() => null);
    } else {
      console.log(`\n临时目录保留 / kept:\n  profile: ${profileDir}\n  extension: ${extensionDir}`);
    }
  }
}

const code = await main();
process.exit(code);
