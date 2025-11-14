import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** ---------- load & validate ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export function loadRegisterMap(relativeJsonPath = "../config/registerMap.json") {
  const p = path.join(__dirname, relativeJsonPath);
  const map = JSON.parse(fs.readFileSync(p, "utf8"));
  validateMap(map);
  return { map };
}

function validateMap(map) {
  if (!map || typeof map !== "object") throw new Error("registerMap missing");
  if (!Array.isArray(map.blocks)) throw new Error("registerMap.blocks missing");
  if (!map.points || typeof map.points !== "object") throw new Error("registerMap.points missing");
  if (!["BE","LE"].includes(map.byte_order || "BE")) throw new Error("byte_order invalid");
  if (!["ABCD","CDAB"].includes(map.word_order || "ABCD")) throw new Error("word_order invalid");
}

/** ---------- public getters ---------- */
export function getBlocks({ map }) {
  // Return shallow copies to avoid accidental mutation
  return map.blocks.map(b => ({ ...b }));
}

export function getPointDef({ map }, pointName) {
  const def = map.points[pointName];
  if (!def) throw new Error(`Unknown point: ${pointName}`);
  return def;
}

/** ---------- decode (reads) ---------- */
// Helpers to resolve per-point overrides or fall back to map defaults
function resolveByteOrder(map, def) {
  return def.byte_order || map.byte_order || "BE";
}
function resolveWordOrder(map, def) {
  return def.word_order || map.word_order || "ABCD";
}
function wordsForType(t) {
  switch (t) {
    case "u16":
    case "i16": return 1;
    case "u32":
    case "i32":
    case "float32": return 2;
    default: throw new Error(`Unsupported type: ${t}`);
  }
}
function assemble32(hiBuf, loBuf, wordOrder) {
  return wordOrder === "CDAB" ? Buffer.concat([loBuf, hiBuf]) : Buffer.concat([hiBuf, loBuf]);
}
function readU16(buf, offset, byteOrder) { return byteOrder === "LE" ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset); }
function readI16(buf, offset, byteOrder) { return byteOrder === "LE" ? buf.readInt16LE(offset)  : buf.readInt16BE(offset); }
function readU32FromWords(hi, lo, byteOrder, wordOrder) {
  const b4 = assemble32(hi, lo, wordOrder);
  return byteOrder === "LE" ? b4.readUInt32LE(0) : b4.readUInt32BE(0);
}
function readI32FromWords(hi, lo, byteOrder, wordOrder) {
  const b4 = assemble32(hi, lo, wordOrder);
  return byteOrder === "LE" ? b4.readInt32LE(0) : b4.readInt32BE(0);
}
function readF32FromWords(hi, lo, byteOrder, wordOrder) {
  const b4 = assemble32(hi, lo, wordOrder);
  return byteOrder === "LE" ? b4.readFloatLE(0) : b4.readFloatBE(0);
}

/**
 * Decode all declared points from provided block buffers.
 * @param {{ map: object }} ctx
 * @param {{[blockName:string]: Buffer}} blockBuffers
 * @returns {{[pointName:string]: number|undefined}}
 */
export function decodePointsFromBlocks({ map }, blockBuffers) {
  const out = {};
  const blocks = map.blocks.map(b => ({ ...b, end: b.start + b.len - 1 }));

  for (const [name, def] of Object.entries(map.points)) {
    const words = wordsForType(def.type);
    const blk = blocks.find(b => def.addr >= b.start && (def.addr + words - 1) <= b.end);
    if (!blk) { out[name] = undefined; continue; }

    const buf = blockBuffers[blk.name];
    if (!buf) { out[name] = undefined; continue; }

    const byteOrder = resolveByteOrder(map, def);
    const wordOrder = resolveWordOrder(map, def);
    const byteIndex = (def.addr - blk.start) * 2;

    try {
      let v;
      if (def.type === "u16") {
        v = readU16(buf, byteIndex, byteOrder);
      } else if (def.type === "i16") {
        v = readI16(buf, byteIndex, byteOrder);
      } else if (def.type === "u32") {
        const hi = buf.slice(byteIndex, byteIndex + 2);
        const lo = buf.slice(byteIndex + 2, byteIndex + 4);
        v = readU32FromWords(hi, lo, byteOrder, wordOrder);
      } else if (def.type === "i32") {
        const hi = buf.slice(byteIndex, byteIndex + 2);
        const lo = buf.slice(byteIndex + 2, byteIndex + 4);
        v = readI32FromWords(hi, lo, byteOrder, wordOrder);
      } else if (def.type === "float32") {
        const hi = buf.slice(byteIndex, byteIndex + 2);
        const lo = buf.slice(byteIndex + 2, byteIndex + 4);
        v = readF32FromWords(hi, lo, byteOrder, wordOrder);
      }

      if (typeof def.scale === "number") v = v * def.scale;
      if (typeof def.offset === "number") v = v + def.offset;

      out[name] = v;
    } catch {
      out[name] = undefined;
    }
  }

  return out;
}

/** ---------- encode (writes) ---------- */
function writeU16(buf, idx, v, byteOrder) { return byteOrder === "LE" ? buf.writeUInt16LE(v, idx) : buf.writeUInt16BE(v, idx); }
function writeI16(buf, idx, v, byteOrder) { return byteOrder === "LE" ? buf.writeInt16LE(v, idx)  : buf.writeInt16BE(v, idx); }
function splitWords(b4, wordOrder) {
  const hi = b4.slice(0, 2), lo = b4.slice(2, 4);
  return wordOrder === "CDAB" ? [lo, hi] : [hi, lo];
}

/**
 * Validate bounds/deadband and produce a Modbus write plan for a point.
 * Returns { fc, start, quantity, words[], value, reason }
 */
export function planWrite({ map }, pointName, rawValue, { allowClamp = true } = {}) {
  const def = getPointDef({ map }, pointName);
  if (def.ro) throw new Error(`Point ${pointName} is read-only`);

  let v = Number(rawValue);
  if (Number.isNaN(v)) throw new Error("Value is NaN");
  let reason = "ok";

  // safe bounds
  if (Array.isArray(def.safe_bounds)) {
    const [lo, hi] = def.safe_bounds;
    if (v < lo || v > hi) {
      if (!allowClamp) throw new Error(`Out of bounds [${lo}, ${hi}]`);
      v = Math.min(hi, Math.max(lo, v));
      reason = "clamped";
    }
  }
  // deadband
  if (typeof def.deadband === "number" && typeof def._lastSet === "number") {
    if (Math.abs(v - def._lastSet) < def.deadband) reason = "deadband_skip";
  }
  def._lastSet = v;

  const byteOrder = resolveByteOrder(map, def);
  const wordOrder = resolveWordOrder(map, def);

  if (def.type === "u16" || def.type === "i16") {
    const b = Buffer.alloc(2);
    (def.type === "u16" ? writeU16 : writeI16)(b, 0, v, byteOrder);
    return { fc: 6, start: def.addr, quantity: 1, words: [b], value: v, reason };
  }

  if (["u32", "i32", "float32"].includes(def.type)) {
    const b4 = Buffer.alloc(4);
    if (def.type === "u32") { byteOrder === "LE" ? b4.writeUInt32LE(v, 0) : b4.writeUInt32BE(v, 0); }
    else if (def.type === "i32") { byteOrder === "LE" ? b4.writeInt32LE(v, 0) : b4.writeInt32BE(v, 0); }
    else { byteOrder === "LE" ? b4.writeFloatLE(v, 0) : b4.writeFloatBE(v, 0); }
    const [w1, w2] = splitWords(b4, wordOrder);
    return { fc: 16, start: def.addr, quantity: 2, words: [w1, w2], value: v, reason };
  }

  throw new Error(`Unsupported write type ${def.type}`);
}
