/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 通用工具：URL、响应头、文件名和大小。
 * Shared helpers for URLs, headers, filenames, and sizes.
 */

import { MIME_EXTENSION_MAP } from './constants.js';

// 仅允许 http(s) 交给 NDM / Only http(s) URLs can be handed to NDM.
export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// 安全解析 URL / Parse a URL without throwing.
export function toUrl(value, base) {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
}

export function hostnameOf(value) {
  const url = toUrl(value);
  return url ? url.hostname.toLowerCase() : '';
}

export function originOf(value) {
  const url = toUrl(value);
  return url ? url.origin : '';
}

// 去掉 hash，Referer 不应包含片段 / Strip the hash because Referer must not include it.
export function stripHash(value) {
  if (!value) return '';
  const index = value.indexOf('#');
  return index === -1 ? value : value.slice(0, index);
}

// 读取响应头，名称不区分大小写 / Read a header case-insensitively.
export function getHeader(headers, name) {
  if (!Array.isArray(headers)) return '';
  const wanted = name.toLowerCase();
  const found = headers.find((header) => String(header.name || '').toLowerCase() === wanted);
  if (!found) return '';
  return String(found.value ?? found.binaryValue ?? '');
}

// 标准化 MIME，去掉参数 / Normalize MIME by dropping parameters.
export function normalizeMime(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

// 从 URL 路径提取扩展名 / Extract an uppercase extension from the URL path.
export function extensionOf(value) {
  const url = toUrl(value);
  if (!url) return '';
  const path = url.pathname || '';
  const last = path.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '';
  let ext = last.slice(dot + 1).trim();
  try {
    ext = decodeURIComponent(ext);
  } catch {
    // 保留原始扩展名 / Keep the raw extension when decoding fails.
  }
  ext = ext.toUpperCase();
  return /^[A-Z0-9]{1,10}$/.test(ext) ? ext : '';
}

// 根据 MIME 推断扩展名 / Infer an extension from a MIME type.
export function extensionFromMime(mime) {
  const mapped = MIME_EXTENSION_MAP[normalizeMime(mime)] || '';
  return mapped.split('|', 1)[0];
}

// 解析 Content-Disposition，支持 filename* / Parse Content-Disposition, including filename*.
export function parseContentDisposition(value) {
  const raw = String(value || '');
  const first = raw.split(';', 1)[0].trim().toLowerCase();
  const result = { type: first, filename: '', filenameStar: '' };
  const star = /filename\*\s*=\s*([^;]+)/i.exec(raw);
  if (star) {
    const part = star[1].trim().replace(/^["']|["']$/g, '');
    const pieces = part.split("''");
    const encoded = pieces.length > 1 ? pieces.slice(1).join("''") : part;
    try {
      result.filenameStar = decodeURIComponent(encoded);
    } catch {
      result.filenameStar = encoded;
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|'([^']*)'|([^;]+))/i.exec(raw);
  if (plain) {
    result.filename = decodeEntire(plain[2] ?? plain[3] ?? plain[4] ?? '');
  }
  return result;
}

function decodeEntire(value) {
  const raw = String(value || '').trim();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// 生成可读文件名；移除路径和非法字符 / Build a safe display filename.
export function safeFilename(value, fallback = 'download') {
  let name = String(value || '')
    .replace(/^.*[\\/]/, '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .trim();
  if (!name || name === '.' || name === '..') name = fallback;
  return name.slice(0, 180);
}

// 从 URL 和响应头推导文件名 / Derive a filename from the URL and headers.
export function filenameFrom(url, disposition) {
  const parsed = parseContentDisposition(disposition);
  const candidate = parsed.filenameStar || parsed.filename;
  if (candidate) return safeFilename(candidate);
  try {
    const pathname = new URL(url).pathname;
    const last = decodeURIComponent(pathname.split('/').pop() || '');
    if (last) return safeFilename(last);
  } catch {
    // 忽略无法解析的 URL / Ignore unparsable URLs.
  }
  return safeFilename(parsed.filenameStar || parsed.filename || 'download');
}

// 解析 Content-Range 中的总大小 / Parse total size from Content-Range.
export function totalSizeFromRange(value) {
  const match = /\/(\d+)\s*$/.exec(String(value || ''));
  return match ? Number(match[1]) : 0;
}

// 格式化字节数 / Format a byte count for the NDM dialog.
export function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

// 判断流媒体分片样式 / Detect segment-like URLs used by streaming players.
export function isSegmentLike(value) {
  const url = toUrl(value);
  if (!url) return false;
  const path = url.pathname.toLowerCase();
  if (/\.(m4s|cmfv|cmfa|cmft)$/i.test(path)) return true;
  return /(?:^|[/_.-])(seg|segment|chunk|frag|fragment|init|part|slice|range)[_.-]?\d*(?:[/_.-]|$)/i.test(path);
}

// 清理请求头里的换行，避免破坏 NDM 协议 / Remove CR/LF so headers cannot break the NDM protocol.
export function sanitizeHeaderValue(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 提取 POST 请求体，并返回与之匹配的 Content-Type。
 * Extract a POST body and the matching Content-Type.
 */
export function serializeRequestBody(requestBody, originalContentType = '') {
  if (!requestBody) return { text: '', contentType: '' };

  if (Array.isArray(requestBody.raw) && requestBody.raw.length) {
    const chunks = [];
    let total = 0;
    for (const part of requestBody.raw) {
      if (!part || !part.bytes) continue;
      const bytes = new Uint8Array(part.bytes);
      if (total + bytes.length > 96 * 1024) break;
      let text = '';
      for (let i = 0; i < bytes.length; i += 1) {
        text += String.fromCharCode(bytes[i]);
      }
      chunks.push(text);
      total += bytes.length;
    }
    return { text: chunks.join(''), contentType: originalContentType };
  }

  if (requestBody.formData && typeof requestBody.formData === 'object') {
    const mime = normalizeMime(originalContentType);
    if (mime === 'multipart/form-data') {
      const boundaryMatch = /boundary=([^;]+)/i.exec(originalContentType);
      const boundary = boundaryMatch?.[1]?.replace(/^["']|["']$/g, '')
        || `----NDMFormBoundary${Math.random().toString(36).slice(2)}`;
      const parts = [];
      for (const [name, values] of Object.entries(requestBody.formData)) {
        const safeName = String(name).replace(/["\r\n]/g, '_');
        for (const value of values || []) {
          parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${String(value)}\r\n`);
        }
      }
      parts.push(`--${boundary}--\r\n`);
      return {
        text: parts.join(''),
        contentType: `multipart/form-data; boundary=${boundary}`
      };
    }

    const params = new URLSearchParams();
    for (const [name, values] of Object.entries(requestBody.formData)) {
      for (const value of values || []) params.append(name, String(value));
    }
    return {
      text: params.toString(),
      contentType: originalContentType || 'application/x-www-form-urlencoded'
    };
  }

  return { text: '', contentType: '' };
}

// 休眠，用于连接重试 / Sleep helper for connection retries.
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
