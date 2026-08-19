// WebSocket 实时推送客户端：/api/ws
// - subscribe=all 时需在连接后发送 {type:'subscribe', ids:[...]} 限定范围
// - 自动心跳（ping 25s）、指数退避重连、页面可见时立即重连
// - batchUpdate 的服务端时间戳同时用于校准全局服务器时钟（见 utils.syncServerTime）

import {syncServerTime} from './utils.js?v=1.1.2';

export class MetricSocket {
  /**
   * @param {object} opts
   * @param {string} opts.scope  'all' 或具体 serverId
   * @param {string[]} opts.ids  scope=all 时的服务器过滤列表
   * @param {function} opts.onBatch  (batchUpdate 消息) => void
   * @param {function} opts.onState  ('connecting'|'open'|'closed') => void
   */
  constructor({ scope = 'all', ids = [], onBatch, onState } = {}) {
    this.scope = scope;
    this.ids = ids;
    this.onBatch = onBatch || (() => {});
    this.onState = onState || (() => {});
    this._closed = false;
    this._retry = 0;
    this._ws = null;
    this._timer = null;
    this._pingTimer = null;
    this._onVisible = () => {
      if (document.visibilityState === 'visible' && !this._closed) {
        if (!this._ws || this._ws.readyState > 1) {
          clearTimeout(this._timer);
          this._retry = 0;
          this._connect();
        }
      }
    };
    document.addEventListener('visibilitychange', this._onVisible);
    this._connect();
  }

  _url() {
    const base = (window.__API_BASE__ || '').replace(/\/$/, '');
    let u;
    if (/^https?:/.test(base)) u = `${base.replace(/^http/, 'ws')}/api/ws`;
    else u = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    return `${u}?subscribe=${encodeURIComponent(this.scope)}`;
  }

  _connect() {
    if (this._closed) return;
    this.onState('connecting');
    let ws;
    try {
      ws = new WebSocket(this._url());
    } catch {
      this._schedule();
      return;
    }
    this._ws = ws;

    ws.onopen = () => {
      this._retry = 0;
      this.onState('open');
      if (this.scope === 'all' && this.ids.length) this._sendSubscribe();
      this._pingTimer = setInterval(() => this._send({ type: 'ping' }), 25_000);
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.type === 'batchUpdate') {
        if (msg.ts) syncServerTime(msg.ts);
        this.onBatch(msg);
      }
    };

    ws.onclose = () => {
      this._cleanupPing();
      if (!this._closed) this._schedule();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _sendSubscribe() {
    this._send({ type: 'subscribe', scope: 'all', ids: this.ids.slice(0, 500) });
  }

  setIds(ids) {
    this.ids = ids;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) this._sendSubscribe();
  }

  _schedule() {
    this.onState('closed');
    const delay = Math.min(30_000, 1000 * 2 ** this._retry);
    this._retry += 1;
    this._timer = setTimeout(() => this._connect(), delay);
  }

  _cleanupPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  close() {
    this._closed = true;
    clearTimeout(this._timer);
    this._cleanupPing();
    document.removeEventListener('visibilitychange', this._onVisible);
    try {
      if (this._ws) this._ws.close();
    } catch {
      /* ignore */
    }
  }
}

