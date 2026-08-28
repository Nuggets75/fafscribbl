'use strict';
// Minimal RFC6455 WebSocket server. No dependencies.
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024; // 1 MB

function encode(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class WSConn {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.dead = false;
    this.isAlive = true;
    this.data = {}; // free-form slot for the app
    this._h = Object.create(null);
  }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
  _emit(ev, a) {
    const list = this._h[ev];
    if (!list) return;
    for (const fn of list) {
      try { fn(a); } catch (e) { console.error('[ws] handler error on ' + ev, e); }
    }
  }
  send(str) {
    if (this.dead) return;
    try { this.socket.write(encode(1, Buffer.from(str, 'utf8'))); }
    catch (e) { this.terminate(); }
  }
  sendJSON(obj) { this.send(JSON.stringify(obj)); }
  ping() {
    if (this.dead) return;
    try { this.socket.write(encode(9, Buffer.alloc(0))); }
    catch (e) { this.terminate(); }
  }
  close(code, reason) {
    if (this.dead) return;
    code = code || 1000; reason = reason || '';
    try {
      const b = Buffer.alloc(2 + Buffer.byteLength(reason));
      b.writeUInt16BE(code, 0);
      b.write(reason, 2);
      this.socket.write(encode(8, b));
    } catch (e) { /* ignore */ }
    this._die();
    try { this.socket.end(); } catch (e) { /* ignore */ }
  }
  terminate() {
    this._die();
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
  }
  _die() {
    if (this.dead) return;
    this.dead = true;
    this._emit('close');
  }
  _push(chunk) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this._drain();
  }
  _drain() {
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this.terminate();
        len = buf.readUInt32BE(6); off = 10;
      }
      if (len > MAX_MESSAGE) return this.terminate();
      const maskLen = masked ? 4 : 0;
      const need = off + maskLen + len;
      if (buf.length < need) return;
      let payload = Buffer.from(buf.slice(off + maskLen, need));
      if (masked) {
        const m = buf.slice(off, off + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      this.buf = buf.slice(need);

      if (op === 0x8) { this.close(1000, ''); return; }
      if (op === 0x9) {
        if (!this.dead) { try { this.socket.write(encode(0xA, payload)); } catch (e) { this.terminate(); } }
        continue;
      }
      if (op === 0xA) { this.isAlive = true; continue; }
      if (op === 0x0) {
        if (!this.frag) return this.terminate();
        this.frag.push(payload);
        if (this.frag.reduce((n, b) => n + b.length, 0) > MAX_MESSAGE) return this.terminate();
        if (fin) { const full = Buffer.concat(this.frag); this.frag = null; this._deliver(this.fragOp, full); }
        continue;
      }
      if (op === 0x1 || op === 0x2) {
        if (!fin) { this.frag = [payload]; this.fragOp = op; continue; }
        this._deliver(op, payload);
        continue;
      }
      return this.terminate();
    }
  }
  _deliver(op, payload) {
    this.isAlive = true;
    if (op !== 0x1) return; // binary unused
    this._emit('message', payload.toString('utf8'));
  }
}

function attach(server, opts) {
  const path = opts.path || '/ws';
  const onConnection = opts.onConnection;
  const conns = new Set();

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { /* ignore */ }
    const key = req.headers['sec-websocket-key'];
    const up = String(req.headers.upgrade || '').toLowerCase();
    if (pathname !== path || up !== 'websocket' || !key) {
      try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) {}
      return socket.destroy();
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const conn = new WSConn(socket, req);
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    socket.on('data', (d) => conn._push(d));
    socket.on('error', () => conn.terminate());
    socket.on('close', () => conn._die());
    if (head && head.length) conn._push(head);
    try { onConnection(conn, req); } catch (e) { console.error('[ws] onConnection', e); conn.terminate(); }
  });

  const hb = setInterval(() => {
    for (const c of conns) {
      if (!c.isAlive) { c.terminate(); continue; }
      c.isAlive = false;
      c.ping();
    }
  }, 25000);
  if (hb.unref) hb.unref();

  return { conns };
}

module.exports = { attach };
