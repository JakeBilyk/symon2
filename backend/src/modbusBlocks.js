/***************************************************************************************************
 * modbusBlocks.js — ESM
 *  - Manages Modbus TCP clients (pooled)
 *  - Provides readBlocksForDevice for telemetry
 *  - Provides writeRegisters for control ops
 *  - Provides runCycleForFamily for polling loop + live cache updates
 **************************************************************************************************/

import net from "net";
import Modbus from "jsmodbus";

/** ---------- simple concurrency limiter (instead of p-limit) ---------- */
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then((res) => {
        active--;
        resolve(res);
        next();
      })
      .catch((err) => {
        active--;
        reject(err);
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/** ---------- client pooling ---------- */

const DEFAULTS = {
  port: 502,
  unitId: 1,
  connectTimeoutMs: 2500,
  requestTimeoutMs: 1500,
  idleCloseMs: 60_000,
  maxRetries: 2
};

// key: "ip:port:unitId" → { client, socket, lastUsed, closing, cfg }
const pool = new Map();

function poolKey(ip, port, unitId) {
  return `${ip}:${port}:${unitId}`;
}

/**
 * Get or create a pooled Modbus TCP client.
 */
export async function getOrCreateModbusClient(
  ip,
  port = DEFAULTS.port,
  unitId = DEFAULTS.unitId,
  opts = {}
) {
  const cfg = { ...DEFAULTS, ...opts, port, unitId };
  const key = poolKey(ip, port, unitId);

  const pooled = pool.get(key);
  if (pooled && !pooled.closing && pooled.socket.readyState === "open") {
    pooled.lastUsed = Date.now();
    return pooled.client;
  }

  const socket = new net.Socket();
  const client = new Modbus.client.TCP(socket, cfg.unitId, cfg.requestTimeoutMs);

  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("connect timeout")), cfg.connectTimeoutMs);
    socket.once("error", (e) => {
      clearTimeout(to);
      reject(e);
    });
    socket.connect(cfg.port, ip, () => {
      clearTimeout(to);
      resolve();
    });
  });

  const pooledNew = {
    client,
    socket,
    lastUsed: Date.now(),
    closing: false,
    cfg
  };
  pool.set(key, pooledNew);

  socket.on("close", () => {
    pooledNew.closing = true;
    pool.delete(key);
  });
  socket.on("error", () => {
    pooledNew.closing = true;
    try {
      socket.destroy();
    } catch {}
    pool.delete(key);
  });

  setTimeout(() => maybeCloseIdle(key), cfg.idleCloseMs).unref();

  return client;
}

function maybeCloseIdle(key) {
  const pooled = pool.get(key);
  if (!pooled) return;
  if (Date.now() - pooled.lastUsed >= pooled.cfg.idleCloseMs) {
    pooled.closing = true;
    try {
      pooled.socket.end();
    } catch {}
    pool.delete(key);
  } else {
    setTimeout(() => maybeCloseIdle(key), pooled.cfg.idleCloseMs).unref();
  }
}

/** ---------- low-level read helpers ---------- */

async function readBlockFC3(client, start, len) {
  const resp = await client.readHoldingRegisters(start, len);
  return Buffer.from(resp.response._body._valuesAsBuffer);
}

/**
 * Read all declared blocks for a device IP.
 * @param {string} ip
 * @param {Array<{name:string, fn:number, start:number, len:number}>} blocks
 * @param {{ unitId?:number, port?:number, maxRetries?:number }} opts
 * @returns {Promise<Record<string, Buffer>>}
 */
export async function readBlocksForDevice(ip, blocks, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const client = await getOrCreateModbusClient(ip, cfg.port, cfg.unitId, cfg);

  const out = {};
  for (const b of blocks) {
    if (b.fn !== 3) {
      throw new Error(`Unsupported fn=${b.fn} (only FC3 supported here)`);
    }
    out[b.name] = await retry(
      async () => {
        const buf = await readBlockFC3(client, b.start, b.len);
        return buf;
      },
      cfg.maxRetries
    );
  }
  return out;
}

/** ---------- writes (for cmdSubscriber) ---------- */

/**
 * Execute a write:
 *  - FC6 for single register
 *  - FC16 for multiple registers
 * @param {string} ip
 * @param {number} fc      6 | 16
 * @param {number} start   register address
 * @param {number[]} regs  array of u16 values OR single u16
 * @param {{ unitId?:number, port?:number, maxRetries?:number }} opts
 */
export async function writeRegisters(ip, fc, start, regs, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const client = await getOrCreateModbusClient(ip, cfg.port, cfg.unitId, cfg);

  const doWrite = async () => {
    if (fc === 6) {
      const v = Array.isArray(regs) ? regs[0] : regs;
      await client.writeSingleRegister(start, v);
      return;
    }
    if (fc === 16) {
      const arr = Array.isArray(regs) ? regs : [regs];
      await client.writeMultipleRegisters(start, arr);
      return;
    }
    throw new Error(`Unsupported write FC=${fc}`);
  };

  await retry(doWrite, cfg.maxRetries);
}

/** ---------- retry helper ---------- */

async function retry(fn, max = 2) {
  let attempt = 0;
  let lastErr;
  while (attempt <= max) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      attempt++;
      if (attempt > max) break;
      await wait(150 + attempt * 200);
    }
  }
  throw lastErr;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ---------- family polling for telemetry + live cache ---------- */

/**
 * Run one full polling cycle for a given family.
 *
 * @param {object} family        - { family, config, mapCtx, devicePrefix, blocks }
 * @param {object} mqttPublisher - object from initMqttPublisher(siteId)
 * @param {object} loggingService- object from initLogging(siteId)
 * @param {Function} onLiveUpdate- callback(tankId, ip, payload) for /api/live
 * @param {object} liveTanks     - map of tankId -> boolean (for ctrl family)
 */
export async function runCycleForFamily(
  family,
  mqttPublisher,
  loggingService,
  onLiveUpdate,
  liveTanks
) {
  const { family: familyName, config, mapCtx, devicePrefix, blocks } = family;
  const tanks = Object.keys(config);
  const limit = createLimiter(8);

  const tasks = tanks.map((tankId) =>
    limit(async () => {
      const cfg = config[tankId];

      if (familyName === "ctrl" && liveTanks && liveTanks[tankId] !== true) {
        return;
      }

      const ip = typeof cfg === "string" ? cfg : cfg.ip;
      const unitId = typeof cfg === "object" && cfg.unitId ? cfg.unitId : 1;
      const deviceId = `${devicePrefix}-${tankId}`;

      try {
        const blkBufs = await readBlocksForDevice(ip, blocks, { unitId });
        if (!blkBufs || Object.keys(blkBufs).length === 0) {
          console.error(`❌ ${familyName}:${tankId} @ ${ip}: no block data returned`);
          return;
        }

        const values = mapCtx.decodePointsFromBlocks
          ? mapCtx.decodePointsFromBlocks(blkBufs)
          : mapCtx.decode(blkBufs);

        const payload = {
          ts_utc: new Date().toISOString(),
          schema_ver: mapCtx.map?.schema_ver || 1,
          site_id: mqttPublisher.siteId,
          tank_id: tankId,
          device_id: deviceId,
          fw: "gw-1.0.0",
          s: values,
          qc: { status: "ok" }
        };

        mqttPublisher.publishTelemetry(familyName, payload);
        loggingService.logTelemetry(familyName, payload);

        if (onLiveUpdate) {
          onLiveUpdate(tankId, ip, payload);
        }

        const short = Object.entries(values)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        console.log(`✅ ${familyName}:${tankId} @ ${ip} → ${short}`);
      } catch (err) {
        console.error(`❌ ${familyName}:${tankId} @ ${ip}:`, err.message);
      }
    })
  );

  await Promise.all(tasks);
}
