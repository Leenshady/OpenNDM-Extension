/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 下载判定规则。保持保守，避免接管普通页面请求。
 * Capture rules. Deliberately conservative so normal browsing is untouched.
 */

import {
  AUTO_CAPTURE_EXTENSIONS,
  EXPLICIT_ONLY_EXTENSIONS,
  FORCED_DOWNLOAD_MIMES,
  HLS_EXTENSIONS,
  HLS_MIMES,
  MEDIA_EXTENSIONS,
  NON_DOWNLOAD_MIMES,
  STREAM_SEGMENT_EXTENSIONS
} from './constants.js';
import {
  extensionFromMime,
  extensionOf,
  filenameFrom,
  isHttpUrl,
  isSegmentLike,
  normalizeMime,
  parseContentDisposition,
  totalSizeFromRange
} from './utils.js';

const MEDIA_MIME_PREFIXES = ['video/', 'audio/'];
const IMAGE_MIME_PREFIX = 'image/';
const SMALL_MEDIA_FALLBACK = 512 * 1024;

/**
 * 判定一个响应是否应交给 NDM。
 * Decide whether a response should be handed to NDM.
 *
 * @param {object} input Response and browser context.
 * @returns {{capture:boolean, kind:'normal'|'media'|'hls', reason:string, size:number, ext:string, filename:string, contentType:string, contentDisposition:string}}
 */
export function decideCapture(input = {}) {
  const result = {
    capture: false,
    kind: 'normal',
    reason: '',
    size: 0,
    ext: '',
    filename: '',
    contentType: '',
    contentDisposition: ''
  };

  const deny = (reason) => {
    result.reason = reason;
    return result;
  };
  const allow = (kind, reason) => {
    result.capture = true;
    result.kind = kind;
    result.reason = reason;
    return result;
  };

  if (!input || typeof input !== 'object') return deny('invalid-context');
  if (input.captureEnabled === false) return deny('capture-disabled');
  if (input.ndmConnected === false) return deny('ndm-disconnected');
  if (input.blocked) return deny('site-blocked');
  if (input.bypass) return deny('user-bypass');
  if (!isHttpUrl(input.url)) return deny('not-http');

  const method = String(input.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return deny('method');
  if (input.statusCode !== 200 && input.statusCode !== 203 && input.statusCode !== 206) {
    return deny('status');
  }

  // 网易邮箱附件链接带有一次性下载票据，浏览器请求后 NDM 重发只会拿到 416。
  // NetEase webmail attachments carry a one-time ticket: NDM's replay only gets a 416.
  if (isNetEaseAttachmentUrl(input.url)) return deny('one-time-attachment');

  const contentType = normalizeMime(input.contentType);
  const contentDisposition = String(input.contentDisposition || '');
  const parsedDisposition = parseContentDisposition(contentDisposition);
  const attachment = parsedDisposition.type === 'attachment';
  const type = String(input.type || 'other');
  const rawLength = Number(input.contentLength);
  const contentLength = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : 0;
  const rangeTotal = totalSizeFromRange(input.contentRange);
  const size = Math.max(contentLength, rangeTotal);

  result.contentType = contentType;
  result.contentDisposition = contentDisposition;
  result.size = size;

  // 206 分片请求只接受明确的附件 / Partial responses are accepted only for explicit attachments.
  if (input.statusCode === 206 && !attachment) return deny('partial-response');

  const urlExt = extensionOf(input.url);
  const mimeExt = extensionFromMime(contentType);
  const filenameExt = extensionOfFromName(parsedDisposition.filenameStar || parsedDisposition.filename);
  // MIME 的自动捕获类型优先，其次文件名，最后 URL 扩展名。
  // Prefer a downloadable MIME, then the filename, then the URL extension.
  const ext = (mimeExt && !EXPLICIT_ONLY_EXTENSIONS.has(mimeExt) ? mimeExt : '')
    || filenameExt
    || urlExt
    || mimeExt;
  result.ext = ext;
  result.filename = filenameFrom(input.url, contentDisposition);

  const isHls = HLS_EXTENSIONS.has(ext) || HLS_MIMES.has(contentType);
  const isMediaMime = MEDIA_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix));
  const isMediaExt = MEDIA_EXTENSIONS.has(ext);
  const isMedia = isMediaMime || isMediaExt;

  // HTML 页面永远不接管，除非服务器明确要求下载 / Never take over an HTML page unless explicitly attached.
  if ((contentType === 'text/html' || contentType === 'application/xhtml+xml') && !attachment) {
    return deny('html-page');
  }

  // B 站播放器预览图/雪碧图不是用户下载目标 / Bilibili preview sprites are not user downloads.
  if (!attachment && isPreviewAssetUrl(input.url)) return deny('preview-asset');

  // HLS 清单优先识别，NDM 可直接处理 / Recognize HLS playlists first.
  if (isHls) {
    if (input.captureMedia === false) return deny('media-disabled');
    result.kind = 'hls';
    return allow('hls', 'hls-playlist');
  }

  // 明确的附件无条件接管 / Explicit attachments always win.
  if (attachment) {
    if (isMedia && input.captureMedia === false) return deny('media-disabled');
    result.kind = isMedia ? 'media' : 'normal';
    return allow(result.kind, 'content-disposition');
  }

  // 图片、脚本、样式、JSON 等只允许附件触发 / Web assets need an explicit attachment.
  if (contentType.startsWith(IMAGE_MIME_PREFIX)) return deny('image-asset');
  if (NON_DOWNLOAD_MIMES.has(contentType)) return deny('browser-asset');
  if (EXPLICIT_ONLY_EXTENSIONS.has(ext)) return deny('explicit-only');

  // 媒体请求：跳过播放器分片，避免疯狂弹窗 / Skip player segments to avoid dialog floods.
  if (isMedia) {
    if (input.captureMedia === false) return deny('media-disabled');
    if (STREAM_SEGMENT_EXTENSIONS.has(ext) && type !== 'media' && type !== 'main_frame') {
      return deny('stream-segment');
    }
    if (type === 'xmlhttprequest' && isSegmentLike(input.url)) return deny('segment-url');
    if (input.statusCode === 206) return deny('partial-media');
    const minSize = Math.max(0, Number(input.mediaMinSize) || 0);
    if (size > 0 && size < minSize && type !== 'media' && type !== 'main_frame') {
      return deny('media-too-small');
    }
    result.kind = 'media';
    return allow('media', 'media-response');
  }

  // 已知可下载扩展名 / Known downloadable extensions.
  if (AUTO_CAPTURE_EXTENSIONS.has(ext)) {
    if (rawLength === 0 && input.contentLength !== undefined && input.contentLength !== null) {
      return deny('empty-file');
    }
    return allow('normal', 'supported-extension');
  }

  // 强制下载 MIME：主文档、对象和较大的未知接口才接管 / Forced-download MIME types.
  if (FORCED_DOWNLOAD_MIMES.has(contentType)) {
    if (type === 'main_frame' || type === 'object') return allow('normal', 'forced-download');
    if (size >= SMALL_MEDIA_FALLBACK) return allow('normal', 'large-binary');
    return deny('small-binary');
  }

  // 无扩展名的下载链接：只接受主文档或大型嵌入对象 / Extensionless URLs need page-level intent.
  if (type === 'main_frame' && contentType && !contentType.startsWith('text/')) {
    return allow('normal', 'main-frame-file');
  }
  if (type === 'object' && size >= SMALL_MEDIA_FALLBACK) {
    return allow('normal', 'embedded-object');
  }

  return deny('not-download');
}

// 常见播放器预览资源路径 / Common player preview asset paths.
function isPreviewAssetUrl(value) {
  try {
    const path = new URL(value).pathname;
    return /(?:^|\/)(?:videoshot[a-z0-9]*|videopreview)(?:[\/_.-]|$)/i.test(path);
  } catch {
    return false;
  }
}

// 网易邮箱（126 / 163 / yeah.net）附件下载地址。
// NetEase webmail attachment endpoint (126 / 163 / yeah.net).
const NETEASE_MAIL_HOSTS = /(?:^|\.)(?:mail\.(?:126|163)\.com|mail\.yeah\.net)$/i;

export function isNetEaseAttachmentUrl(value) {
  try {
    const url = new URL(value);
    if (!NETEASE_MAIL_HOSTS.test(url.hostname)) return false;
    if (!/\/js6\/read\/readdata\.jsp$/i.test(url.pathname)) return false;
    return /(?:^|[?&])action=download_attach(?:&|$)/i.test(url.search);
  } catch {
    return false;
  }
}

// 从文件名提取扩展名 / Read an extension from a filename.
function extensionOfFromName(value) {
  const name = String(value || '').trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).trim().toUpperCase();
}

/**
 * 判断一个 URL 是否看起来像可下载文件，仅用于提示。
 * Heuristic used by the UI to show a hint; never used as the only capture signal.
 */
export function looksDownloadable(url) {
  const ext = extensionOf(url);
  return AUTO_CAPTURE_EXTENSIONS.has(ext) || HLS_EXTENSIONS.has(ext) || EXPLICIT_ONLY_EXTENSIONS.has(ext);
}
