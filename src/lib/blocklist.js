/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 网站屏蔽列表：支持域名、子域名与 IP。
 * Site blocklist: matches domains, subdomains, and IP addresses.
 */

import { hostnameOf, toUrl } from './utils.js';

/**
 * 规范化用户输入的站点。
 * Normalize user input into a hostname.
 */
export function normalizeHost(value) {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  raw = raw.replace(/^\*\./, '').replace(/\.$/, '');
  if (!raw) return '';

  // 支持直接粘贴完整 URL / Accept a pasted URL.
  if (raw.includes('://')) {
    const url = toUrl(raw);
    return url ? validateHost(url.hostname) : '';
  }

  // 支持 example.com/path 和 example.com:8080 / Accept path or port suffixes.
  if (raw.includes('/')) raw = raw.split('/', 1)[0];
  let parsed = null;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return '';
  }
  return validateHost(parsed.hostname);
}

function validateHost(value) {
  const host = String(value || '').toLowerCase().replace(/\.$/, '');
  if (!host) return '';
  if (host.includes('..') || host.startsWith('.') || host.endsWith('.')) return '';
  if (!/^[a-z0-9.\-:[\]]+$/i.test(host)) return '';
  // 拒绝单独的 TLD，避免误屏蔽整个 .com / Reject a bare TLD so a typo cannot block all .com sites.
  if (!host.includes('.') && host !== 'localhost' && !host.includes(':')) return '';
  return host;
}

/**
 * 判断主机是否命中黑名单（包含子域名）。
 * Return true when a host matches a rule or one of its subdomains.
 */
export function isHostBlocked(host, rules) {
  if (!host || !Array.isArray(rules) || rules.length === 0) return false;
  const target = String(host).toLowerCase().replace(/\.$/, '');
  return rules.some((rule) => {
    const blocked = String(rule || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    if (!blocked) return false;
    return target === blocked || target.endsWith(`.${blocked}`);
  });
}

/**
 * 判断 URL 的主机是否被屏蔽。
 * Check a URL against the blocklist.
 */
export function isUrlBlocked(url, rules) {
  return isHostBlocked(hostnameOf(url), rules);
}

/**
 * 判断请求目标、发起页或标签页是否有一个被屏蔽。
 * A request is blocked when its target, initiator, or tab host is blocked.
 */
export function isRequestBlocked({ url, initiator, documentUrl, tabUrl, rules }) {
  const hosts = [hostnameOf(url), hostnameOf(initiator), hostnameOf(documentUrl), hostnameOf(tabUrl)];
  return hosts.some((host) => host && isHostBlocked(host, rules));
}

/**
 * 移除覆盖指定主机的规则（可能是父域名）。
 * Remove the rule that covers a host, which may be a parent domain.
 */
export function removeHostRule(host, rules) {
  if (!host || !Array.isArray(rules)) return rules || [];
  const next = [...rules];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (isHostBlocked(host, [next[i]])) next.splice(i, 1);
  }
  return next;
}

/**
 * 合并并去重屏蔽列表。
 * Merge and dedupe blocklist entries.
 */
export function mergeHosts(...lists) {
  const seen = new Set();
  const result = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const host = normalizeHost(item);
      if (host && !seen.has(host)) {
        seen.add(host);
        result.push(host);
      }
    }
  }
  return result.sort();
}
