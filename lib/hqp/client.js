"use strict";
// ---------------------------------------------------------------------------
// One HQPlayer control connection. Ported from hqpweb
// (packages/protocol/src/client.ts), MIT, (c) 2026 statelycurmudgeon — see
// ./LICENSE.
//
// The first request on a new connection costs 265–606 ms; later requests on
// the same connection take ~1 ms (measured 2026-10-02, two instances). So the
// client keeps ONE connection per HQPlayer and sends requests over it one at a
// time, and closes it when idle, a little before HQPlayer itself would
// (~156 s, measured).
//
// Two changes from the original, both about running inside a long-lived
// server that does other things: a reply waiter is tied to the socket it was
// sent on (a connection dropped by a timeout closes asynchronously, and its
// close must not fail the NEXT request, already waiting on a new one), and
// every socket has one 'error' listener for its whole life — an 'error' with
// no listener is an uncaught exception, which would take the whole extension
// down over an HQPlayer that went away.
// ---------------------------------------------------------------------------

const net = require("node:net");
const { cmd } = require("./commands");
const p = require("./parse");
const { PROLOG, parseDocument } = require("./xml");

const DEFAULT_PORT = 4321;

class HqpClient {
  /**
   * @param {string} host
   * @param {{port?: number, timeoutMs?: number, idleMs?: number}} [opts]
   *   timeoutMs: the first SetFilter for a filter blocked ~5 s while HQPlayer
   *   prepared it (measured), so the default leaves plenty of room.
   */
  constructor(host, opts) {
    const o = opts || {};
    this.host = host;
    this.port = o.port || DEFAULT_PORT;
    this.timeoutMs = o.timeoutMs || 15000;
    this.idleMs = o.idleMs || 120000;
    this.sock = null;
    this.buf = "";
    this.waiter = null;        // { sock, resolve(line), reject(err) } for the request in flight
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.connections = 0;      // opened so far (diagnostics and tests)
    this.closed = false;
  }

  /** Send one request and parse the reply. Requests are queued: one in flight at a time. */
  request(body) {
    const run = this.queue.then(() => this.exchange(body));
    this.queue = run.catch(() => undefined);
    return run.then(parseDocument);
  }

  async exchange(body) {
    const reused = this.sock !== null;
    try {
      return await this.once(body);
    } catch (e) {
      // A kept-open connection may have been closed by HQPlayer while idle.
      // Retry once on a fresh one. Safe for setters too: every one of them
      // carries an absolute value, so sending it twice changes nothing.
      if (reused && e && e.stale) return this.once(body);
      throw e;
    }
  }

  async once(body) {
    const sock = await this.connected();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.waiter && this.waiter.sock === sock) this.waiter = null;
        if (this.closed) return;
        this.idleTimer = setTimeout(() => this.drop(), this.idleMs);
        this.idleTimer.unref();
      };
      const timer = setTimeout(() => {
        finish();
        this.drop();
        reject(new Error("timeout after " + this.timeoutMs + " ms waiting for " + this.host + ":" + this.port));
      }, this.timeoutMs);
      this.waiter = {
        sock,
        resolve: (line) => { finish(); resolve(line); },
        reject: (e) => { finish(); reject(e); },
      };
      sock.write(PROLOG + body + "\n");
    });
  }

  connected() {
    if (this.closed) return Promise.reject(new Error("HQPlayer connection closed"));
    if (this.sock) return Promise.resolve(this.sock);
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      let open = false;
      sock.setEncoding("utf8");
      sock.setNoDelay(true);
      const fail = (e) => {
        sock.destroy();
        reject(e);
      };
      // The socket went away after it was in use: the request waiting on it
      // (if any) fails as STALE, which earns it one retry on a new connection.
      const lost = (e) => {
        if (this.sock === sock) this.sock = null;
        const w = this.waiter;
        if (!w || w.sock !== sock) return;
        const err = e || new Error("connection to " + this.host + ":" + this.port + " closed");
        err.stale = true;
        w.reject(err);
      };
      sock.on("error", (e) => (open ? lost(e) : fail(e)));
      sock.on("close", () => (open ? lost() : fail(new Error("connection to " + this.host + ":" + this.port + " closed"))));
      sock.setTimeout(this.timeoutMs, () => {
        if (!open) fail(new Error("timeout connecting to " + this.host + ":" + this.port));
      });
      sock.once("connect", () => {
        open = true;
        sock.setTimeout(0);
        if (this.closed) { sock.destroy(); reject(new Error("HQPlayer connection closed")); return; }
        this.connections++;
        this.sock = sock;
        this.buf = "";
        sock.on("data", (d) => {
          if (this.sock !== sock) return;
          this.buf += d;
          let nl;
          while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            const w = this.waiter;
            if (w && w.sock === sock) w.resolve(line);
          }
        });
        resolve(sock);
      });
    });
  }

  drop() {
    if (this.sock) this.sock.destroy();
    this.sock = null;
  }

  /** Close for good: nothing in flight survives, and no new connection is ever opened. */
  close() {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.drop();
  }

  /** Send a command and report its outcome. An OK is NOT proof of effect: read State back. */
  async send(body) {
    return p.outcome(await this.request(body));
  }

  async info() { return p.parseInfo(await this.request(cmd.getInfo())); }
  async state() { return p.parseState(await this.request(cmd.state())); }
  async status() { return p.parseStatus(await this.request(cmd.status())); }
  async modes() { return p.parseModes(await this.request(cmd.getModes())); }
  async filters() { return p.parseFilters(await this.request(cmd.getFilters())); }
  async shapers() { return p.parseShapers(await this.request(cmd.getShapers())); }
  async rates() { return p.parseRates(await this.request(cmd.getRates())); }
  async volumeRange() { return p.parseVolumeRange(await this.request(cmd.volumeRange())); }
  async matrixProfiles() { return p.parseMatrixProfiles(await this.request(cmd.matrixListProfiles())); }
}

module.exports = { HqpClient, DEFAULT_PORT };
