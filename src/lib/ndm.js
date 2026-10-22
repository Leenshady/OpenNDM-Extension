/*
 * OpenNDM-Extension
 * Copyright (C) 2026 OpenNDM-Extension contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * NDM 本地协议客户端：WebSocket + 纯文本消息。
 * NDM local protocol client: WebSocket plus line-based messages.
 */

import { NDM_PROTOCOL } from './constants.js';
import { sanitizeHeaderValue } from './utils.js';

const encoder = new TextEncoder();

/**
 * 构造 NDM 消息。字段格式与 NDM 扩展协议保持一致。
 * Build an NDM message using the established extension protocol fields.
 */
export function buildNdmMessage(payload = {}) {
  const method = String(payload.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const kind = ['normal', 'media', 'hls'].includes(payload.type) ? payload.type : 'normal';
  const url = sanitizeHeaderValue(payload.url);
  if (!url) return '';

  const lines = [];
  lines.push(`1:${method}`);
  lines.push(`2:${url}`);
  lines.push(`6:${kind}`);

  if (payload.title) lines.push(`4:${sanitizeHeaderValue(payload.title)}`);
  if (payload.origin) lines.push(`Origin: ${sanitizeHeaderValue(payload.origin)}`);
  if (payload.referer) lines.push(`Referer: ${sanitizeHeaderValue(payload.referer)}`);
  if (payload.pageUrl) lines.push(`5:${sanitizeHeaderValue(payload.pageUrl)}`);
  if (payload.cookies) lines.push(`Cookie: ${sanitizeHeaderValue(payload.cookies)}`);
  if (payload.requestContentType) {
    lines.push(`Content-Type: ${sanitizeHeaderValue(payload.requestContentType)}`);
  }
  // 不要回传响应的 Content-Disposition：NDM 会把它当作请求头发给服务器。
  // Never echo the response Content-Disposition: NDM sends it as a request header.
  if (payload.description) lines.push(`9:${sanitizeHeaderValue(payload.description)}`);

  const extraHeaders = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};
  for (const [name, value] of Object.entries(extraHeaders)) {
    const key = sanitizeHeaderValue(name);
    const headerValue = sanitizeHeaderValue(value);
    if (!key || !headerValue) continue;
    if (!/^[A-Za-z0-9-]+$/.test(key)) continue;
    if (!/^x-/i.test(key) && key.toLowerCase() !== 'authorization') continue;
    lines.push(`${key}: ${headerValue}`);
  }

  if (Number(payload.size) > 0) lines.push(`7:${Math.floor(Number(payload.size))}`);
  const responseContentType = payload.responseContentType || payload.contentType || '';
  if (responseContentType) lines.push(`8:${sanitizeHeaderValue(responseContentType)}`);

  if (method === 'POST') {
    if (payload.postData) {
      lines.push(`__0NeatPostData9__:${payload.postData}`);
    } else {
      lines.push('Content-Length: 0');
    }
  }

  let message = `${lines.join('\r\n')}\r\n`;

  // 超长时依次丢弃 Cookie 和附加头 / Drop Cookie and extras if the message is too large.
  if (encoder.encode(message).length > NDM_PROTOCOL.maxMessageBytes) {
    const cookieIndex = lines.findIndex((line) => /^Cookie:/i.test(line));
    if (cookieIndex !== -1) {
      lines.splice(cookieIndex, 1);
      message = `${lines.join('\r\n')}\r\n`;
    }
  }
  if (encoder.encode(message).length > NDM_PROTOCOL.maxMessageBytes) {
    const trimmed = lines.filter((line) => !/^x-/i.test(line) && !/^Authorization:/i.test(line));
    message = `${trimmed.join('\r\n')}\r\n`;
  }
  if (encoder.encode(message).length > NDM_PROTOCOL.maxMessageBytes) return '';
  return message;
}

/**
 * 单例 WebSocket 客户端。NDM 只监听本机端口。
 * Singleton WebSocket client for NDM's local port.
 */
export class NdmClient {
  constructor({ port = NDM_PROTOCOL.defaultPort, onState = null, onPanelPreference = null, onWaiting = null } = {}) {
    this.port = port;
    this.onState = onState;
    this.onPanelPreference = onPanelPreference;
    this.onWaiting = onWaiting;
    this.lastPayload = null;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.version = '';
    this.lastError = '';
    this.retryDelay = 2000;
    this.retryTimer = null;
    this.connectTimer = null;
    this.lastStateKey = '';
  }

  getState() {
    return {
      connected: this.connected,
      port: this.port,
      version: this.version,
      lastError: this.lastError
    };
  }

  setPort(port) {
    const next = Number(port);
    if (!Number.isInteger(next) || next < 1 || next > 65535 || next === this.port) return;
    this.port = next;
    this.version = '';
    this.close();
    this.retryDelay = 2000;
    this.connect();
  }

  ensureConnected() {
    if (!this.connected && !this.connecting) this.connect();
  }

  connect() {
    if (this.connected || this.connecting) return;
    if (typeof WebSocket === 'undefined') {
      this.lastError = 'WebSocket unavailable';
      this.emitState();
      return;
    }

    this.connecting = true;
    this.lastError = '';
    let socket;
    try {
      socket = new WebSocket(`ws://${NDM_PROTOCOL.host}:${this.port}${NDM_PROTOCOL.path}`, NDM_PROTOCOL.subprotocol);
    } catch (error) {
      this.connecting = false;
      this.lastError = String(error && error.message ? error.message : error);
      this.emitState();
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      if (!this.connected && this.socket === socket) {
        this.lastError = 'Connection timeout';
        try { socket.close(); } catch { /* ignore */ }
      }
    }, 5000);

    socket.onopen = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.connecting = false;
      this.connected = true;
      this.retryDelay = 2000;
      this.lastError = '';
      this.emitState();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const data = typeof event.data === 'string' ? event.data : '';
      if (!data) return;
      if (data.startsWith('Version')) {
        const value = data.includes('=') ? data.slice(data.indexOf('=') + 1).trim() : '';
        if (value) {
          this.version = value;
          this.emitState();
        }
      } else if (data.startsWith('ShowPanelChrome') && typeof this.onPanelPreference === 'function') {
        const value = data.includes('=') ? data.slice(data.indexOf('=') + 1).trim() === '1' : false;
        this.onPanelPreference(value);
      } else if (data === 'waiting' && typeof this.onWaiting === 'function' && this.lastPayload) {
        try {
          this.onWaiting(this.lastPayload);
        } catch {
          // 等待回调失败不应断开连接 / A waiting callback failure must not close the socket.
        }
      }
    };

    socket.onclose = () => {
      // 旧连接关闭时不要影响新连接 / Ignore a stale socket closing after a port change.
      if (this.socket !== socket) return;
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.socket = null;
      this.connecting = false;
      this.connected = false;
      this.emitState();
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.lastError = 'Connection failed';
      if (!this.connected) this.emitState();
    };
  }

  /**
   * 发送消息；waitMs > 0 时等待连接建立。
   * Send a message; waitMs > 0 waits briefly for the socket.
   */
  async send(payload, { waitMs = 0 } = {}) {
    const message = buildNdmMessage(payload);
    if (!message) {
      this.lastError = 'Message too large';
      return false;
    }

    if (!this.connected) {
      if (waitMs <= 0) return false;
      this.connect();
      const deadline = Date.now() + waitMs;
      while (!this.connected && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (!this.connected) return false;
    }

    try {
      this.lastPayload = payload;
      this.socket.send(message);
      return true;
    } catch (error) {
      this.lastError = String(error && error.message ? error.message : error);
      this.emitState();
      return false;
    }
  }

  close() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    this.retryTimer = null;
    this.connectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }
    this.emitState();
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.connected) this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(30000, Math.round(this.retryDelay * 1.7));
  }

  emitState() {
    if (typeof this.onState !== 'function') return;
    const state = this.getState();
    const key = `${state.connected}|${state.port}|${state.version}`;
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    try {
      this.onState(state);
    } catch {
      // 状态回调错误不应中断连接 / A bad callback must not break the client.
    }
  }
}
