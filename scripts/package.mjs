/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 打包发布包：从 manifest 出发收集运行所需文件，输出到 dist/。
 * Build the release zip: collect only the files the extension needs at runtime.
 *
 * 用法 / Usage:
 *   node scripts/package.mjs [--out <file.zip>] [--dry-run] [--verbose]
 */

import { deflateRawSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 固定时间戳，保证同样的源码得到同样的 zip。
// Fixed timestamp so identical sources produce an identical archive.
const ZIP_TIME = 0;
const ZIP_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const TEXT_EXTENSIONS = /\.(?:html?|css|m?js)$/i;

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = { out: '', dryRun: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      options.out = argv[i + 1] || '';
      i += 1;
      if (!options.out) fail('--out 需要一个文件路径 / --out needs a path');
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法 / usage: node scripts/package.mjs [--out <file.zip>] [--dry-run] [--verbose]');
      process.exit(0);
    } else {
      fail(`未知参数 / unknown argument: ${arg}`);
    }
  }
  return options;
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* File collection                                                            */
/* -------------------------------------------------------------------------- */

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function resolveRef(baseFile, ref) {
  const clean = ref.split('#')[0].split('?')[0].trim();
  if (!clean) return '';
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean) || clean.startsWith('/')) return '';
  const resolved = toPosix(join(dirname(baseFile), clean));
  if (resolved.startsWith('../') || resolved === '..') {
    fail(`引用超出了扩展根目录 / reference escapes the extension root: ${ref} (from ${baseFile})`);
  }
  return resolved.replace(/^\.\//, '');
}

function htmlRefs(text) {
  const refs = [];
  for (const match of text.matchAll(/<(?:link|script|img|source)\b[^>]*?\b(?:href|src)="([^"]+)"/gi)) {
    refs.push(match[1]);
  }
  return refs;
}

function cssRefs(text) {
  const refs = [];
  for (const match of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
    refs.push(match[1]);
  }
  return refs;
}

function jsModuleRefs(text) {
  const refs = [];
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) refs.push(match[1]);
  }
  return refs;
}

function markupRefs(file, text) {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (extension === '.html' || extension === '.htm') return htmlRefs(text);
  if (extension === '.css') return cssRefs(text);
  if (extension === '.js' || extension === '.mjs') return jsModuleRefs(text);
  return [];
}

export function collectFiles(manifest) {
  const files = new Set();
  const add = (value) => {
    if (!value || typeof value !== 'string') return false;
    const normalized = resolveRef('manifest.json', value);
    if (!normalized) return false;
    const before = files.size;
    files.add(normalized);
    return files.size !== before;
  };

  add('manifest.json');
  add(manifest.background?.service_worker);
  for (const script of manifest.background?.scripts || []) add(script);

  add(manifest.options_ui?.page);
  add(manifest.options_page);
  add(manifest.action?.default_popup);
  add(manifest.side_panel?.default_path);
  add(manifest.devtools_page);

  const iconSets = [manifest.icons, manifest.action?.default_icon];
  for (const set of iconSets) {
    if (!set) continue;
    if (typeof set === 'string') add(set);
    else for (const icon of Object.values(set)) add(icon);
  }

  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }

  for (const resource of manifest.web_accessible_resources || []) {
    for (const file of resource.resources || []) {
      if (file.includes('*')) continue;
      add(file);
    }
  }

  // 语言包：manifest.default_locale 之外的同级语言也要带上。
  // Ship every locale folder, not only the default one.
  const localesDir = join(root, '_locales');
  if (existsSync(localesDir)) {
    for (const entry of readdirSync(localesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const messages = `_locales/${entry.name}/messages.json`;
      if (existsSync(join(root, messages))) add(messages);
    }
  }

  // GPL 分发需要附带许可证 / The GPL requires shipping the licence text.
  if (existsSync(join(root, 'LICENSE'))) add('LICENSE');

  // 顺着 HTML / CSS / ES module 引用继续收集。
  // Follow markup, stylesheet, and module references.
  const queue = [...files];
  while (queue.length) {
    const file = queue.shift();
    const absolute = join(root, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    if (!TEXT_EXTENSIONS.test(file)) continue;
    const text = readFileSync(absolute, 'utf8');
    for (const ref of markupRefs(file, text)) {
      const resolved = resolveRef(file, ref);
      if (!resolved || files.has(resolved)) continue;
      files.add(resolved);
      queue.push(resolved);
    }
  }

  return [...files].sort();
}

function verifyFiles(files) {
  const missing = files.filter((file) => !existsSync(join(root, file)));
  if (missing.length) {
    fail(`manifest 引用了不存在的文件 / missing files:\n  ${missing.join('\n  ')}`);
  }
}

/* -------------------------------------------------------------------------- */
/* ZIP writer (stored + deflated entries, no dependencies)                    */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const compressed = deflated.length < entry.data.length;
    const body = compressed ? deflated : entry.data;
    const method = compressed ? 8 : 0;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 file names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(ZIP_TIME, 10);
    header.writeUInt16LE(ZIP_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(ZIP_TIME, 12);
    record.writeUInt16LE(ZIP_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, directory, end]);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  } catch (error) {
    fail(`无法读取 manifest.json / cannot read manifest.json: ${error.message}`);
  }

  if (!manifest.version) fail('manifest.json 缺少 version / missing version');

  const files = collectFiles(manifest);
  verifyFiles(files);

  const entries = files.map((file) => ({
    name: file,
    data: readFileSync(join(root, file))
  }));
  const archive = buildZip(entries);

  const outPath = resolve(root, options.out || `dist/openndm-extension-v${manifest.version}.zip`);

  if (options.dryRun) {
    for (const entry of entries) {
      console.log(`${formatBytes(entry.data.length).padStart(9)}  ${entry.name}`);
    }
    console.log(`\n${entries.length} files · would write ${outPath}`);
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, archive);

  if (options.verbose) {
    for (const entry of entries) {
      console.log(`${formatBytes(entry.data.length).padStart(9)}  ${entry.name}`);
    }
    console.log('');
  }

  const relativeOut = toPosix(outPath).replace(`${toPosix(root)}/`, '');
  console.log(`OK ${entries.length} files → ${relativeOut} (${formatBytes(archive.length)})`);
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();

