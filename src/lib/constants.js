/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 共享常量：扩展名、MIME 与默认设置。
 * Shared constants: extensions, MIME groups, and defaults.
 */

// 视频/音频扩展名，与参考插件保持一致 / Media extensions, kept compatible with the reference add-on.
export const MEDIA_EXTENSIONS = new Set([
  'FLV', 'SWF', 'MP3', 'MP4', 'M4V', 'F4F', 'F4V', 'M4A', 'MPG', 'MPEG',
  'MPEG4', 'MPE', 'AVI', 'WMV', 'WMA', 'WAV', 'WAVE', 'ASF', 'RM', 'RAM',
  'OGG', 'OGV', 'OGM', 'OGA', 'MOV', 'MID', 'MIDI', '3GP', '3GPP', 'QT',
  'WEBM', 'TS', 'MKV', 'AAC', 'MP2T', 'MPEGTS', 'RMVB', 'M2TS', 'MTS',
  'OPUS', 'FLAC', 'AIFF', 'AIF', 'CAF'
]);

// 压缩包、安装包与镜像 / Archives, installers, and disk images.
export const ARCHIVE_EXTENSIONS = new Set([
  'ZIP', 'RAR', '7Z', 'TAR', 'GZ', 'GZIP', 'BZ2', 'XZ', 'ZST', 'LZ', 'LZMA',
  'ARJ', 'Z', 'PLJ', 'CAB', 'ISO', 'IMG', 'DMG', 'PKG', 'MPKG', 'MSI', 'MSP',
  'EXE', 'DLL', 'SDLC', 'APK', 'IPA', 'DEB', 'RPM', 'JAR', 'XAP', 'CRX',
  'TORRENT'
]);

// 文档、电子书与字幕 / Documents, e-books, and subtitles.
export const DOCUMENT_EXTENSIONS = new Set([
  'PDF', 'DOC', 'DOCX', 'DOT', 'DOTX', 'XLS', 'XLSX', 'XLT', 'XLTX',
  'PPT', 'PPTX', 'PPS', 'PPSX', 'POT', 'POTX', 'EPUB', 'MOBI', 'AZW', 'AZW3',
  'MSG', 'EML', 'CSV', 'RTF', 'ODT', 'ODS', 'ODP', 'SRT', 'VTT', 'ASS', 'SSA',
  'DFXP', 'TTML', 'F4M'
]);

// 图片和网页资源默认只允许“另存为/附件”触发 / Images and web assets need an explicit attachment.
export const EXPLICIT_ONLY_EXTENSIONS = new Set([
  'HTML', 'HTM', 'MHT', 'MHTML', 'SHTML', 'SHTM', 'XHT', 'XHTM', 'XHTML',
  'XML', 'TXT', 'CSS', 'JS', 'MJS', 'JSON', 'MAP', 'PHP', 'ASP', 'ASPX',
  'CGI', 'WASM', 'EOT', 'TTF', 'OTF', 'WOFF', 'WOFF2', 'GIF', 'ICO', 'CUR',
  'JPEG', 'JPG', 'PNG', 'APNG', 'WEBP', 'BMP', 'SVG', 'SVGZ', 'TIF', 'TIFF',
  'XBM', 'AVIF', 'HEIC', 'HEIF', 'DICT', 'DO', 'ACZ', 'AZC', 'TPL', 'OSD',
  'PEM', 'BR', 'BIN'
]);

// 可直接自动捕获的扩展名 / Extensions eligible for automatic capture.
export const AUTO_CAPTURE_EXTENSIONS = new Set([
  ...MEDIA_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS
]);

// HLS 清单 / HLS playlists.
export const HLS_EXTENSIONS = new Set(['M3U8', 'M3U']);
export const HLS_MIMES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'video/mpegurl',
  'video/x-mpegurl'
]);

// 流媒体分片，避免把播放器的每个分片都送进 NDM / Streaming segments must not flood NDM.
export const STREAM_SEGMENT_EXTENSIONS = new Set([
  'TS', 'MP2T', 'MPEGTS', 'M2TS', 'MTS', 'M4S', 'CMFV', 'CMFA', 'CMFT'
]);

// 浏览器会直接处理的 MIME，默认不自动捕获 / MIME types the browser should keep handling.
export const NON_DOWNLOAD_MIMES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/json',
  'application/ld+json',
  'application/xml',
  'text/xml',
  'application/wasm',
  'text/event-stream',
  'application/x-javascript',
  'text/x-javascript',
  'text/x-json',
  'application/manifest+json',
  'application/problem+json',
  'application/x-www-form-urlencoded',
  'multipart/form-data'
]);

// 强制下载 MIME，常见于动态下载接口 / Forced-download MIME types used by download endpoints.
export const FORCED_DOWNLOAD_MIMES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/download',
  'application/force-download',
  'application/x-download',
  'application/x-msdownload',
  'application/x-apple-diskimage',
  'application/vnd.android.package-archive',
  'application/x-iso9660-image',
  'application/x-msi'
]);

// MIME -> 首选扩展名，用于没有文件名的下载 / MIME to preferred extension when the URL has no filename.
export const MIME_EXTENSION_MAP = Object.freeze({
  'application/x-apple-diskimage': 'DMG',
  'application/cert-chain+cbor': 'MSG',
  'application/epub+zip': 'EPUB',
  'application/java-archive': 'JAR',
  'application/vnd.android.package-archive': 'APK',
  'application/vnd.apple.installer+xml': 'MPKG',
  'application/vnd.apple.mpegurl': 'M3U8',
  'application/x-mpegurl': 'M3U8',
  'application/mpegurl': 'M3U8',
  'application/f4m+xml': 'F4M',
  'application/gzip': 'GZ',
  'application/x-gzip': 'GZ',
  'application/x-gzip-compressed': 'GZ',
  'application/x-7z-compressed': '7Z',
  'application/x-rar': 'RAR',
  'application/x-rar-compressed': 'RAR',
  'application/x-tar': 'TAR',
  'application/x-gtar': 'TAR',
  'application/zip': 'ZIP',
  'application/x-zip': 'ZIP',
  'application/x-zip-compressed': 'ZIP',
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/vnd.oasis.opendocument.text': 'ODT',
  'application/vnd.oasis.opendocument.spreadsheet': 'ODS',
  'application/vnd.oasis.opendocument.presentation': 'ODP',
  'text/csv': 'CSV',
  'application/x-iso9660-image': 'ISO',
  'application/vnd.rar': 'RAR',
  'application/x-msdownload': 'EXE',
  'application/x-msi': 'MSI',
  'application/x-msp': 'MSP',
  'application/x-msdos-program': 'EXE',
  'application/x-ole-storage': 'MSI',
  'application/x-sdlc': 'SDLC',
  'application/x-shockwave-flash': 'SWF',
  'application/x-silverlight-app': 'XAP',
  'application/x-subrip': 'SRT',
  'application/x-compress': 'Z',
  'application/x-compressed': 'ARJ',
  'application/x-aim': 'PLJ',
  'text/srt': 'SRT',
  'text/vtt': 'VTT',
  'text/plain': 'TXT',
  'text/css': 'CSS',
  'text/javascript': 'JS',
  'application/javascript': 'JS',
  'application/json': 'JSON',
  'text/xml': 'XML',
  'application/ttaf+xml': 'DFXP',
  'video/3gpp': '3GP',
  'video/3gpp2': '3GPP',
  'video/avi': 'AVI',
  'video/x-msvideo': 'AVI',
  'video/msvideo': 'AVI',
  'video/f4f': 'F4F',
  'video/f4m': 'F4M',
  'video/flv': 'FLV',
  'video/x-flv': 'FLV',
  'video/x-flash-video': 'FLV',
  'flv-application/octet-stream': 'FLV',
  'video/mp2t': 'TS',
  'video/mp4': 'MP4',
  'video/x-mp4': 'MP4',
  'video/mpg4': 'MP4',
  'video/x-mpg4': 'MP4',
  'video/mpeg': 'MPG',
  'video/mpegurl': 'M3U8',
  'video/quicktime': 'MOV',
  'video/webm': 'WEBM',
  'video/x-ms-asf': 'ASF',
  'video/x-ms-wmv': 'WMV',
  'video/x-matroska': 'MKV',
  'audio/3gpp': '3GP',
  'audio/3gpp2': '3GPP',
  'audio/mp3': 'MP3',
  'audio/mp4': 'M4A',
  'audio/mp4a-latm': 'M4A',
  'audio/mpeg': 'MP3',
  'audio/mpeg4-generic': 'M4A',
  'audio/mpegurl': 'M3U8',
  'audio/x-mpegurl': 'M3U8',
  'audio/x-mpeg': 'MP3',
  'audio/x-mp3': 'MP3',
  'audio/webm': 'WEBM',
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/x-ms-wma': 'WMA',
  'audio/aac': 'AAC',
  'audio/x-aac': 'AAC',
  'audio/x-hx-aac-adts': 'AAC',
  'image/svg+xml': 'SVG',
  'image/gif': 'GIF',
  'image/icon': 'ICO',
  'image/x-icon': 'ICO',
  'image/jpg': 'JPG',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/tiff': 'TIF',
  'image/webp': 'WEBP',
  'image/vnd.microsoft.icon': 'ICO'
});

// 默认设置 / Default settings.
export const DEFAULT_SETTINGS = Object.freeze({
  captureEnabled: true,
  captureMedia: true,
  showMediaPanel: true,
  autoCancelBrowserDownload: true,
  ndmPort: 10007,
  mediaMinSize: 512 * 1024
});

// NDM 本地 WebSocket 协议 / NDM local WebSocket protocol.
export const NDM_PROTOCOL = Object.freeze({
  host: '127.0.0.1',
  path: '/download',
  subprotocol: 'neatextension.v1',
  defaultPort: 10007,
  maxMessageBytes: 118784
});

// webRequest 关注的资源类型 / Resource types watched through webRequest.
export const REQUEST_TYPES = [
  'main_frame',
  'sub_frame',
  'object',
  'xmlhttprequest',
  'media',
  'other'
];

// 上下文缓存上限 / Bounds for request-context and dedupe caches.
export const LIMITS = Object.freeze({
  requestContexts: 3000,
  contextAgeMs: 45_000,
  recentSent: 500,
  pendingCancel: 100,
  mediaPerTab: 30,
  recentCaptures: 20,
  bypassTtlMs: 4000
});

// 内部消息名 / Internal message names.
export const MSG = Object.freeze({
  GET_STATE: 'GET_STATE',
  SET_SETTINGS: 'SET_SETTINGS',
  SET_SITE_BLOCKED: 'SET_SITE_BLOCKED',
  REMOVE_BLOCKED_SITE: 'REMOVE_BLOCKED_SITE',
  BYPASS: 'BYPASS',
  DOWNLOAD_URL: 'DOWNLOAD_URL',
  MEDIA_FOUND: 'MEDIA_FOUND',
  TEST_CONNECTION: 'TEST_CONNECTION',
  CLEAR_RECENT: 'CLEAR_RECENT',
  STATE_CHANGED: 'STATE_CHANGED',
  MEDIA_ADD: 'MEDIA_ADD',
  MEDIA_CLEAR: 'MEDIA_CLEAR',
  SHOW_TOAST: 'SHOW_TOAST',
  PAGE_READY: 'PAGE_READY'
});
