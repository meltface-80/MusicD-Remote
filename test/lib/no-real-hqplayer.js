"use strict";
// ---------------------------------------------------------------------------
// No test may connect to TCP 4321. On a machine that runs HQPlayer that port
// is somebody's music system, and the controller's tests change filters and
// the volume. Every HQPlayer test runs against the fake on a port the system
// picks, and requires this first so that a slip — a default port left in, a
// fake that did not start — fails loudly instead of reaching the real thing.
// Ported from hqpweb (test/no-real-hqplayer.ts), MIT, (c) 2026
// statelycurmudgeon — see lib/hqp/LICENSE.
// ---------------------------------------------------------------------------

const net = require("node:net");

const REAL_HQPLAYER_PORT = 4321;

if (!net.Socket.prototype.__noRealHqplayer) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let a = args[0];
    if (Array.isArray(a)) a = a[0]; // net.connect passes normalised args
    const port = typeof a === "object" && a !== null ? a.port : a;
    if (Number(port) === REAL_HQPLAYER_PORT) {
      throw new Error("tests must never connect to port 4321 (a real HQPlayer)");
    }
    return connect.apply(this, args);
  };
  Object.defineProperty(net.Socket.prototype, "__noRealHqplayer", { value: true });
}

module.exports = { REAL_HQPLAYER_PORT };
