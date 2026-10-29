/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 打包脚本测试：只收集运行所需文件，并输出合法 zip。
 * Packaging tests: only runtime files are collected and the archive stays valid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildZip, collectFiles } from '../scripts/package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));

test('collects only the files the extension needs at runtime', () => {
  const files = collectFiles(manifest);

  for (const expected of [
    'manifest.json',
    'src/background.js',
    'src/content/catcher.js',
    'src/lib/rules.js', // 通过 import 图收集 / reached through the import graph
    'src/ui/base.css', // 通过 HTML link 收集 / reached through the popup markup
    'src/popup/popup.js',
    '_locales/en/messages.json',
    '_locales/zh_CN/messages.json',
    'LICENSE'
  ]) {
    assert.ok(files.includes(expected), `${expected} should ship`);
  }

  for (const excluded of ['package.json', 'README.md', 'DEVELOPMENT.md', 'scripts/package.mjs', 'tests/rules.test.mjs']) {
    assert.ok(!files.includes(excluded), `${excluded} should not ship`);
  }

  assert.equal(files.some((file) => file.startsWith('tests/')), false);
  assert.equal(files.some((file) => file.startsWith('node_modules/')), false);
});

test('builds a zip with manifest.json at the root', () => {
  const files = collectFiles(manifest);
  const entries = files.map((file) => ({
    name: file,
    data: readFileSync(resolve(root, file))
  }));
  const archive = buildZip(entries);

  // 本地文件头 / first local file header
  assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304');
  // 中央目录结束记录 / end of central directory
  const eocd = archive.length - 22;
  assert.equal(archive.subarray(eocd, eocd + 4).toString('hex'), '504b0506');
  assert.equal(archive.readUInt16LE(eocd + 8), entries.length);
  assert.equal(archive.readUInt16LE(eocd + 10), entries.length);

  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  assert.equal(directoryOffset + directorySize, eocd);
  assert.ok(archive.subarray(directoryOffset, directoryOffset + 4).toString('hex') === '504b0102');

  assert.equal(entries[0].name < entries[entries.length - 1].name, true);
  assert.ok(entries.some((entry) => entry.name === 'manifest.json'));
});
