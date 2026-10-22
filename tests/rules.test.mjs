/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * 规则单元测试：确保只接管真正的下载。
 * Unit tests for capture rules and NDM message formatting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideCapture } from '../src/lib/rules.js';
import { buildNdmMessage } from '../src/lib/ndm.js';
import { isHostBlocked, normalizeHost, removeHostRule } from '../src/lib/blocklist.js';
import { extensionFromMime, extensionOf, parseContentDisposition, serializeRequestBody } from '../src/lib/utils.js';

const base = {
  method: 'GET',
  type: 'xmlhttprequest',
  statusCode: 200,
  captureEnabled: true,
  captureMedia: true,
  mediaMinSize: 512 * 1024,
  ndmConnected: true,
  blocked: false,
  bypass: false
};

test('captures a normal ZIP download', () => {
  const result = decideCapture({ ...base, url: 'https://example.com/archive.zip', contentType: 'application/zip', contentLength: 1024 });
  assert.equal(result.capture, true);
  assert.equal(result.kind, 'normal');
  assert.equal(result.ext, 'ZIP');
});

test('does not capture HTML pages', () => {
  const result = decideCapture({ ...base, type: 'main_frame', url: 'https://example.com/page', contentType: 'text/html; charset=utf-8', contentLength: 4000 });
  assert.equal(result.capture, false);
  assert.equal(result.reason, 'html-page');
});

test('captures HTML only when the server marks it as an attachment', () => {
  const result = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'https://example.com/save',
    contentType: 'text/html',
    contentDisposition: 'attachment; filename="invoice.html"',
    contentLength: 4000
  });
  assert.equal(result.capture, true);
  assert.equal(result.reason, 'content-disposition');
});

test('captures a direct MP4 response as media', () => {
  const result = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'https://cdn.example.com/movie.mp4',
    contentType: 'video/mp4',
    contentLength: 8 * 1024 * 1024
  });
  assert.equal(result.capture, true);
  assert.equal(result.kind, 'media');
});

test('does not capture every small XHR video chunk', () => {
  const result = decideCapture({
    ...base,
    url: 'https://cdn.example.com/chunk-004.mp4',
    contentType: 'video/mp4',
    contentLength: 240 * 1024
  });
  assert.equal(result.capture, false);
  assert.equal(result.reason, 'segment-url');
});

test('captures HLS playlists', () => {
  const result = decideCapture({
    ...base,
    url: 'https://cdn.example.com/master.m3u8',
    contentType: 'application/vnd.apple.mpegurl',
    contentLength: 1200
  });
  assert.equal(result.capture, true);
  assert.equal(result.kind, 'hls');
});

test('does not capture images, JSON, scripts, or styles', () => {
  const cases = [
    ['https://example.com/pic.jpg', 'image/jpeg'],
    ['https://example.com/data.json', 'application/json'],
    ['https://example.com/app.js', 'application/javascript'],
    ['https://example.com/app.css', 'text/css']
  ];
  for (const [url, contentType] of cases) {
    const result = decideCapture({ ...base, url, contentType, contentLength: 100_000 });
    assert.equal(result.capture, false, url);
  }
});

test('captures an image only as an explicit navigational attachment', () => {
  const result = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'https://example.com/photo',
    contentType: 'image/jpeg',
    contentDisposition: 'attachment; filename="photo.jpg"',
    contentLength: 100_000
  });
  assert.equal(result.capture, true);
});

test('ignores Bilibili videoshot preview sprites', () => {
  const result = decideCapture({
    ...base,
    url: 'https://boss.hdslb.com/videoshotpvhdboss/42571662639_8esu8b.bin',
    contentType: 'application/octet-stream',
    contentLength: 5 * 1024 * 1024,
    type: 'xmlhttprequest'
  });
  assert.equal(result.capture, false);
  assert.equal(result.reason, 'preview-asset');

  const mediaTyped = decideCapture({
    ...base,
    url: 'https://boss.hdslb.com/videoshotpvhdboss/42571662639_8esu8b.bin',
    contentType: 'video/mp4',
    contentLength: 5 * 1024 * 1024
  });
  assert.equal(mediaTyped.capture, false);
  assert.equal(mediaTyped.reason, 'preview-asset');
});

test('does not auto-capture ambiguous .bin files', () => {
  const result = decideCapture({
    ...base,
    url: 'https://example.com/payload.bin',
    contentType: 'application/octet-stream',
    contentLength: 5 * 1024 * 1024
  });
  assert.equal(result.capture, false);
  assert.equal(result.reason, 'explicit-only');
});

test('captures .bin only with an attachment header or manual action', () => {
  const result = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'https://example.com/payload.bin',
    contentType: 'application/octet-stream',
    contentDisposition: 'attachment; filename="firmware.bin"',
    contentLength: 5 * 1024 * 1024
  });
  assert.equal(result.capture, true);
});

test('leaves JS blob downloads to the browser', () => {
  // 后端返回 octet-stream + 存储名，页面再用 a.download 转成 blob 下载。
  // The API answers octet-stream with the storage name; the page re-wraps it as a blob download.
  const xhr = decideCapture({
    ...base,
    type: 'xmlhttprequest',
    url: 'http://10.18.58.1:8021/admin/api/attachment/downloadDatasourceByUploadPath/governTaskDetails?dataId=1&filename=aae96db617304ab48b0fc388dd1447fd.docx',
    contentType: 'application/octet-stream;charset=UTF-8',
    contentDisposition: 'attachment;filename=aae96db617304ab48b0fc388dd1447fd.docx',
    contentLength: 110294
  });
  assert.equal(xhr.capture, false);
  assert.equal(xhr.reason, 'js-blob-download');

  // 同样的响应若是导航式下载，仍然接管 / The same response is captured when navigated to.
  const navigation = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'http://10.18.58.1:8021/admin/api/attachment/downloadDatasourceByUploadPath/governTaskDetails?dataId=1&filename=aae96db617304ab48b0fc388dd1447fd.docx',
    contentType: 'application/octet-stream;charset=UTF-8',
    contentDisposition: 'attachment;filename=aae96db617304ab48b0fc388dd1447fd.docx',
    contentLength: 110294
  });
  assert.equal(navigation.capture, true);

  // 媒体 XHR 仍要进媒体面板 / Media XHR responses must still reach the media panel.
  const media = decideCapture({
    ...base,
    type: 'xmlhttprequest',
    url: 'https://cdn.example.com/movie.mp4',
    contentType: 'video/mp4',
    contentDisposition: 'attachment; filename="movie.mp4"',
    contentLength: 8 * 1024 * 1024
  });
  assert.equal(media.capture, true);
  assert.equal(media.kind, 'media');
});

test('keeps normal Bilibili video downloads working', () => {
  const result = decideCapture({
    ...base,
    url: 'https://upos-sz-mirror.example.bilivideo.com/video.mp4',
    contentType: 'video/mp4',
    contentLength: 10 * 1024 * 1024
  });
  assert.equal(result.capture, true);
  assert.equal(result.kind, 'media');
});

test('uses a downloadable MIME for extensionless or script URLs', () => {
  const result = decideCapture({
    ...base,
    url: 'https://example.com/download.php?id=42',
    contentType: 'application/zip',
    contentLength: 4096
  });
  assert.equal(result.capture, true);
  assert.equal(result.ext, 'ZIP');
});

test('prefers a filename from Content-Disposition over the URL extension', () => {
  const result = decideCapture({
    ...base,
    url: 'https://example.com/download.php?id=42',
    contentType: 'application/octet-stream',
    contentDisposition: 'inline; filename="report.zip"',
    contentLength: 120_000
  });
  assert.equal(result.capture, true);
  assert.equal(result.ext, 'ZIP');
});

test('handles octet-stream conservatively', () => {
  const small = decideCapture({ ...base, url: 'https://example.com/api/blob', contentType: 'application/octet-stream', contentLength: 100_000 });
  assert.equal(small.capture, false);
  const large = decideCapture({ ...base, url: 'https://example.com/api/blob', contentType: 'application/octet-stream', contentLength: 2 * 1024 * 1024 });
  assert.equal(large.capture, true);
  const mainFrame = decideCapture({ ...base, type: 'main_frame', url: 'https://example.com/download/42', contentType: 'application/octet-stream' });
  assert.equal(mainFrame.capture, true);
});

test('rejects partial responses, blocked sites, bypass, and disabled capture', () => {
  assert.equal(decideCapture({ ...base, url: 'https://example.com/file.zip', contentType: 'application/zip', statusCode: 206 }).capture, false);
  assert.equal(decideCapture({ ...base, url: 'https://example.com/file.zip', contentType: 'application/zip', blocked: true }).capture, false);
  assert.equal(decideCapture({ ...base, url: 'https://example.com/file.zip', contentType: 'application/zip', bypass: true }).capture, false);
  assert.equal(decideCapture({ ...base, url: 'https://example.com/file.zip', contentType: 'application/zip', captureEnabled: false }).capture, false);
  assert.equal(decideCapture({ ...base, url: 'https://example.com/file.zip', contentType: 'application/zip', ndmConnected: false }).capture, false);
});

test('leaves one-time NetEase webmail attachments to the browser', () => {
  const url = 'https://mail.126.com/js6/read/readdata.jsp?sid=x&mid=420:abc&part=3&mode=download&l=read&action=download_attach';
  const result = decideCapture({
    ...base,
    type: 'main_frame',
    url,
    contentType: 'application/pdf',
    contentDisposition: 'attachment; filename="=?UTF8?B?5rWL6K+V?="',
    contentLength: 20000
  });
  assert.equal(result.capture, false);
  assert.equal(result.reason, 'one-time-attachment');

  const preview = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'https://preview.mail.126.com/download.do?uid=a&mid=b&part=3&filename=report.pdf',
    contentType: 'application/pdf',
    contentLength: 20000
  });
  assert.equal(preview.capture, true);
});

test('ignores attachment responses from browser-native internal APIs', () => {
  // Office Online 的预取接口：XHR POST + application/json + Content-Disposition: attachment（无文件名）。
  // Office Online prefetch API: XHR POST, JSON, and a nameless "attachment" disposition.
  const office = decideCapture({
    ...base,
    method: 'POST',
    type: 'xmlhttprequest',
    url: 'https://psg4-excel.officeapps.live.com/afhs/AppPrefetchResources.ashx',
    contentType: 'application/json; charset=utf-8',
    contentDisposition: 'attachment',
    contentLength: 25841
  });
  assert.equal(office.capture, false);
  assert.equal(office.reason, 'internal-api');

  // 即使自报文件名，XHR 也不是导航式下载 / A named XHR response is still not a navigational download.
  const namedXhr = decideCapture({
    ...base,
    type: 'xmlhttprequest',
    url: 'https://example.com/api/export',
    contentType: 'application/json',
    contentDisposition: 'attachment; filename="report.json"',
    contentLength: 4096
  });
  assert.equal(namedXhr.capture, false);
  assert.equal(namedXhr.reason, 'internal-api');

  // 顶层导航式的下载仍然接管 / Top-level navigational downloads are still captured.
  const namedNavigation = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'https://example.com/api/export',
    contentType: 'application/json',
    contentDisposition: 'attachment; filename="report.json"',
    contentLength: 4096
  });
  assert.equal(namedNavigation.capture, true);
  assert.equal(namedNavigation.reason, 'content-disposition');

  const unnamedNavigation = decideCapture({
    ...base,
    type: 'main_frame',
    url: 'https://example.com/api/export',
    contentType: 'application/json',
    contentDisposition: 'attachment',
    contentLength: 4096
  });
  assert.equal(unnamedNavigation.capture, true);
});

test('does not flood NDM with TS segments', () => {
  const result = decideCapture({
    ...base,
    url: 'https://cdn.example.com/hls/segment-12.ts',
    contentType: 'video/mp2t',
    contentLength: 4 * 1024 * 1024
  });
  assert.equal(result.capture, false);
  assert.equal(result.reason, 'stream-segment');
});

test('parses filenames and extensions', () => {
  const disposition = parseContentDisposition("attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.zip; filename=\"fallback.zip\"");
  assert.equal(disposition.filenameStar, '测试.zip');
  assert.equal(extensionOf('https://example.com/a/b/movie.MP4?token=1'), 'MP4');
  assert.equal(extensionFromMime('text/plain; charset=utf-8'), 'TXT');
  assert.equal(extensionFromMime('video/mp4'), 'MP4');
});

test('matches blocked hosts and subdomains', () => {
  assert.equal(normalizeHost('https://www.Example.com/path'), 'www.example.com');
  assert.equal(normalizeHost('example.com:8080'), 'example.com');
  assert.equal(normalizeHost('com'), '');
  assert.equal(normalizeHost('http://com'), '');
  assert.equal(isHostBlocked('a.example.com', ['example.com']), true);
  assert.equal(isHostBlocked('example.com.evil.test', ['example.com']), false);
  assert.deepEqual(removeHostRule('a.example.com', ['example.com', 'other.test']), ['other.test']);
});

test('builds a protocol-compatible NDM message', () => {
  const message = buildNdmMessage({
    url: 'https://example.com/movie.mp4',
    method: 'GET',
    type: 'media',
    title: 'Movie page',
    description: 'Video · MP4 · 8.0 MB',
    pageUrl: 'https://example.com/watch',
    referer: 'https://example.com/watch',
    origin: 'https://example.com',
    cookies: 'a=1; b=2',
    contentType: 'video/mp4',
    contentDisposition: 'attachment; filename="movie.mp4"',
    size: 8 * 1024 * 1024,
    headers: { 'X-Token': 'ok', 'User-Agent': 'ignored' }
  });
  assert.match(message, /^1:GET\r\n/);
  assert.match(message, /\r\n2:https:\/\/example\.com\/movie\.mp4\r\n/);
  assert.match(message, /\r\n6:media\r\n/);
  assert.match(message, /\r\nCookie: a=1; b=2\r\n/);
  assert.match(message, /\r\n7:8388608\r\n/);
  assert.match(message, /\r\nX-Token: ok\r\n/);
  assert.doesNotMatch(message, /User-Agent/);
  // NDM 会把该响应头当作请求头回传 / NDM echoes this response header into the request.
  assert.doesNotMatch(message, /Content-Disposition:/i);
});

test('serializes URL-encoded and multipart POST bodies', () => {
  const encoded = serializeRequestBody({
    formData: { file: ['report'], token: ['abc'] }
  }, 'application/x-www-form-urlencoded');
  assert.equal(encoded.text, 'file=report&token=abc');
  assert.match(encoded.contentType, /x-www-form-urlencoded/);

  const multipart = serializeRequestBody({
    formData: { file: ['report'] }
  }, 'multipart/form-data; boundary=TestBoundary');
  assert.match(multipart.text, /--TestBoundary/);
  assert.match(multipart.text, /name="file"/);
  assert.equal(multipart.contentType, 'multipart/form-data; boundary=TestBoundary');
});

test('separates request and response content types', () => {
  const message = buildNdmMessage({
    url: 'https://example.com/export',
    method: 'POST',
    type: 'normal',
    requestContentType: 'multipart/form-data; boundary=TestBoundary',
    responseContentType: 'application/zip',
    postData: 'body'
  });
  assert.match(message, /\r\nContent-Type: multipart\/form-data; boundary=TestBoundary\r\n/);
  assert.match(message, /\r\n8:application\/zip\r\n/);
  assert.match(message, /\r\n__0NeatPostData9__:body\r\n/);
});

test('sanitizes CRLF in NDM messages', () => {
  const message = buildNdmMessage({
    url: 'https://example.com/file.zip',
    title: 'safe\r\nInjected: yes',
    cookies: 'a=1\r\nInjected: yes'
  });
  assert.doesNotMatch(message, /\r\nInjected:/);
});
