/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 静态校验：清单、资源、国际化键与页面引用。
 * Static checks for manifest resources, locale keys, and page references.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

function readJson(relativePath) {
  const absolute = resolve(root, relativePath);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

function requireFile(relativePath, label) {
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    errors.push(`${label}: missing file ${relativePath}`);
  }
}

// Chrome 版本号：1-4 个点分整数，取值 0-65535，非零数字不能以 0 开头。
// Chrome versions: 1-4 dot-separated integers, 0-65535, no leading zeroes.
function isChromeVersion(value) {
  const parts = String(value || '').split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every((part) => /^(?:0|[1-9]\d*)$/.test(part) && Number(part) <= 65535);
}

const manifest = readJson('manifest.json');
if (manifest) {
  if (manifest.manifest_version !== 3) errors.push('manifest.json: manifest_version must be 3');
  if (manifest.default_locale !== 'en') errors.push('manifest.json: default_locale must be en for fallback');
  if (!isChromeVersion(manifest.version)) {
    errors.push('manifest.json: version must be 1-4 dot-separated integers (0-65535), e.g. 0.1.1');
  }
  if (manifest.background?.type !== 'module') errors.push('manifest.json: background.type must be module');
  if (!manifest.background?.service_worker) errors.push('manifest.json: missing background.service_worker');
  else requireFile(manifest.background.service_worker, 'manifest.background');

  if (!manifest.action?.default_popup) errors.push('manifest.json: missing action.default_popup');
  else requireFile(manifest.action.default_popup, 'manifest.action');

  if (manifest.options_ui?.page) requireFile(manifest.options_ui.page, 'manifest.options_ui');
  else errors.push('manifest.json: missing options_ui.page');

  for (const [size, icon] of Object.entries(manifest.icons || {})) {
    requireFile(icon, `manifest.icons.${size}`);
  }
  for (const [size, icon] of Object.entries(manifest.action?.default_icon || {})) {
    requireFile(icon, `manifest.action.default_icon.${size}`);
  }

  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) requireFile(file, 'manifest.content_scripts');
    for (const file of script.css || []) requireFile(file, 'manifest.content_scripts');
  }

  const requiredPermissions = ['webRequest', 'downloads', 'cookies', 'storage', 'contextMenus', 'webNavigation', 'alarms'];
  for (const permission of requiredPermissions) {
    if (!(manifest.permissions || []).includes(permission)) {
      errors.push(`manifest.json: missing permission ${permission}`);
    }
  }

  const messages = [...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((match) => match[1]);
  const locales = ['en', 'zh_CN'];
  for (const locale of locales) {
    const localePath = `_locales/${locale}/messages.json`;
    const localeJson = readJson(localePath);
    if (!localeJson) continue;
    for (const key of messages) {
      if (!localeJson[key]?.message) errors.push(`${localePath}: missing manifest key ${key}`);
    }
  }
}

// 扩展版本号以 manifest 为准，package.json 必须同步。
// The manifest owns the version; package.json must mirror it.
const packageJson = readJson('package.json');
if (manifest && packageJson && packageJson.version !== manifest.version) {
  errors.push(`package.json: version (${packageJson.version}) must match manifest.json (${manifest.version})`);
}

function walkHtml(relativePath) {
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return;
  const text = readFileSync(absolute, 'utf8');
  const keys = [...text.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
  for (const match of text.matchAll(/<link[^>]+href="([^"]+)"[^>]*>/g)) {
    const href = match[1];
    if (/^https?:/i.test(href) || href.startsWith('#')) continue;
    requireFile(resolve(dirname(relativePath), href), `${relativePath} stylesheet`);
  }
  for (const match of text.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/g)) {
    const src = match[1];
    if (/^https?:/i.test(src)) {
      errors.push(`${relativePath}: external script ${src}`);
      continue;
    }
    requireFile(resolve(dirname(relativePath), src), `${relativePath} script`);
  }
  return keys;
}

const htmlKeys = [
  ...(walkHtml('src/popup/popup.html') || []),
  ...(walkHtml('src/options/options.html') || [])
];

const jsFiles = [
  'src/background.js',
  'src/content/catcher.js',
  'src/popup/popup.js',
  'src/options/options.js',
  'src/lib/ndm.js',
  'src/lib/rules.js',
  'src/lib/blocklist.js',
  'src/lib/settings.js',
  'src/lib/utils.js'
];

const jsKeys = [];
for (const file of jsFiles) {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) {
    errors.push(`missing JS file ${file}`);
    continue;
  }
  const text = readFileSync(absolute, 'utf8');
  for (const match of text.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
    jsKeys.push(match[1]);
  }
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    requireFile(resolve(dirname(file), specifier), `${file} import`);
  }
}

const locales = ['en', 'zh_CN'];
for (const locale of locales) {
  const localePath = `_locales/${locale}/messages.json`;
  const localeJson = readJson(localePath);
  if (!localeJson) continue;
  for (const key of new Set([...htmlKeys, ...jsKeys])) {
    if (!localeJson[key]?.message) errors.push(`${localePath}: missing key ${key}`);
  }
  const expectedName = locale === 'zh_CN' ? '开源NDM扩展' : 'OpenNDM-Extension';
  if (localeJson.extName?.message !== expectedName) {
    errors.push(`${localePath}: extName should be ${expectedName}`);
  }
}

// 校验页面引用的资源 / Verify visible web-accessible resources.
requireFile('src/ui/base.css', 'UI');
requireFile('src/popup/popup.css', 'UI');
requireFile('src/options/options.css', 'UI');
requireFile('LICENSE', 'license');
requireFile('README.md', 'readme');
requireFile('DEVELOPMENT.md', 'docs');

if (warnings.length) {
  for (const warning of warnings) console.warn(`WARN ${warning}`);
}
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exit(1);
}
console.log(`OK manifest v${manifest?.version || '?'} · ${new Set([...htmlKeys, ...jsKeys]).size} i18n keys · ${jsFiles.length} scripts`);
