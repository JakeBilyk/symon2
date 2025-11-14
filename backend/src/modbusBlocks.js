// Manages Modbus TCP clients and provides fast block reads with retries.
// Requires: jsmodbus ^4.x, Node >=18

import net from "net";
import Modbus from "jsmodbus";

const DEFAULTS = {
  port: 502,
  unitId: 1,
  connectTimeoutMs: 2500,
  requestTimeoutMs: 1500,
  idleCloseMs: 60_000,
  maxRetries: 2
};

// simple client pool keyed by ip
const pool = new Map();

/**
 * Get or create a pooled Modbus TCP client for an IP.
 * Returns { client, socket, lastUsed, closing }
 */
export async function getClient(ip, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const pooled = pool.get(ip);
  if (pooled && !pooled.closing && pooled.socket.readyState === "open") {
    pooled.lastUsed = Date.now();
    return pooled;
  }

  // Create fresh client
  const socket = new net.Socket();
  // jsmodbus v4 client build
  const client = new Modbus.client.TCP(socket, cfg.unitId, cfg.requestTimeoutMs);

  // Connection promise with timeout
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("connect timeout")), cfg.connectTimeoutMs);
    socket.once("error", (e) => { clearTimeout(to); reject(e); });
    socket.connect(cfg.port, ip, () => { clearTimeout(to); resolve(); });
  });

  // Auto close after idle
  const pooledNew = {
    client, socket, lastUsed: Date.now(), closing: false, ip, cfg
  };
  pool.set(ip, pooledNew);

  socket.on("close", () => { pooledNew.closing = true; pool.delete(ip); });
  socket.on("error", () => { pooledNew.closing = true; try { socket.destroy(); } catch {} pool.delete(ip); });

  // Idle reaper
  setTimeout(() => maybeCloseIdle(ip), cfg.idleCloseMs).unref();

  return pooledNew;
}

function maybeCloseIdle(ip) {
  const pooled = pool.get(ip);
  if (!pooled) return;
  if (Date.now() - pooled.lastUsed >= pooled.cfg.idleCloseMs) {
    pooled.closing = true;
    try { pooled.socket.end(); } catch {}
    pool.delete(ip);
  } else {
    // reschedule
    setTimeout(() => maybeCloseIdle(ip), pooled.cfg.idleCloseMs).unref();
  }
}

/**
 * Read a single block (FC3) and return a Buffer of len*2 bytes.
 */
async function readBlockFC3(client, start, len) {
  const resp = await client.readHoldingRegisters(start, len);
  // jsmodbus v4: _valuesAsBuffer is BE-per-word
  return Buffer.from(resp.response._body._valuesAsBuffer);
}

/**
 * Read all declared blocks for a device IP.
 * @param {string} ip
 * @param {Array<{name:string, fn:number, start:number, len:number}>} blocks
 * @param {{retries?:number, ...DEFAULTS}} opts
 * @returns {Promise<Record<string, Buffer>>}
 */
export async function readBlocksForDevice(ip, blocks, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { client } = await getClient(ip, cfg);
  const out = {};
  for (const b of blocks) {
    if (b.fn !== 3) throw new Error(`Unsupported fn=${b.fn} (only FC3 supported here)`);
    out[b.name] = await retry(async () => {
      const buf = await readBlockFC3(client, b.start, b.len);
      return buf;
    }, cfg.maxRetries);
  }
  return out;
}

/**
 * Execute a write:
 *  - FC6 for single register
 *  - FC16 for multiple registers
 * @param {string} ip
 * @param {number} fc 6|16
 * @param {number} start register address
 * @param {number[]} regs array of 16-bit unsigned integers (for FC16) or a single u16 (for FC6)
 * @param {object} opts
 * @returns {Promise<void>}
 */
export async function writeRegisters(ip, fc, start, regs, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { client } = await getClient(ip, cfg);

  if (fc === 6) {
    const v = Array.isArray(regs) ? regs[0] : regs;
    await retry(() => client.writeSingleRegister(start, v), cfg.maxRetries);
    return;
  }
  if (fc === 16) {
    const arr = Array.isArray(regs) ? regs : [regs];
    await retry(() => client.writeMultipleRegisters(start, arr), cfg.maxRetries);
    return;
  }
  throw new Error(`Unsupported write FC=${fc}`);
}

async function retry(fn, max = 2) {
  let attempt = 0;
  let lastErr;
  while (attempt <= max) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      await wait(150 + attempt * 200);
      attempt++;
    }
  }
  throw lastErr;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
