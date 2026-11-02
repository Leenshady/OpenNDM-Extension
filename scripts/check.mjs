/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 推送门禁：清单校验 → 单元测试 → 本地夹具全量断言，任一步失败即以非零码退出。
 * Push gate: manifest checks, unit suites, then the offline fixture assertions.
 * Any failing step stops the run with a non-zero exit code.
 *
 * 夹具模式双向断言：该抓的一条不能少，不该抓的一条也不能多——这正是
 * 「确认不会下载预期以外的文件」这条门禁的判据。
 * The fixture suite asserts both directions, which is how this gate proves the extension
 * never hands NDM a download the user did not expect.
 *
 * 用法 / usage:
 *   node scripts/check.mjs                # 完整门禁（需要本机有 Chrome/Edge）
 *   node scripts/check.mjs --no-fixtures  # 无浏览器环境：只跑清单与单元测试
 *   node scripts/check.mjs --verbose      # 打印每一步的完整输出
 */

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose') || argv.includes('-v');
const skipFixtures = argv.includes('--no-fixtures');

const UNIT_TESTS = [
  'tests/background.test.mjs',
  'tests/rules.test.mjs',
  'tests/capture.test.mjs',
  'tests/package.test.mjs'
];

function run(label, args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: verbose ? 'inherit' : 'pipe',
    encoding: 'utf8'
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${result.stdout || ''}${result.stderr || ''}`;

  if (result.status === 0) {
    console.log(`✔ ${label} (${seconds}s)`);
    if (verbose) console.log(output.replace(/^/gm, '    '));
    return true;
  }

  console.log(`✖ ${label} (${seconds}s) exit=${result.status ?? 'signal'}`);
  for (const line of output.trim().split('\n').slice(-40)) console.log(`    ${line}`);
  return false;
}

const steps = [{ label: 'validate 清单/i18n/版本', args: ['scripts/validate.mjs'] }];
for (const file of UNIT_TESTS) steps.push({ label: `unit ${file}`, args: [file] });
if (!skipFixtures) {
  steps.push({ label: 'fixtures 夹具全量断言', args: ['scripts/web-test.mjs', '--fixtures'] });
} else {
  console.log('（跳过夹具测试 --no-fixtures：不验证实际捕获行为，仅供无浏览器环境使用）');
  console.log('(fixtures skipped: capture behaviour is NOT verified — browserless environments only)');
}

const failed = [];
for (const step of steps) {
  if (!run(step.label, step.args)) failed.push(step.label);
}

console.log('');
if (failed.length) {
  console.log(`门禁未通过 / gate failed: ${failed.join('、')}`);
  console.log('修复后重新运行；未通过不要 push。');
  process.exit(1);
}

const extra = skipFixtures ? '（未跑夹具测试）' : '';
console.log(`门禁通过 / gate green: ${steps.length} steps${extra}`);
