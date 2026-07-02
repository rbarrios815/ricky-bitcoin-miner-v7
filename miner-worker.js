'use strict';
importScripts('sha256.js');

let running = false;
let batchSize = 256;
let workerId = 0;
let nonce = 0;
let header = new Uint8Array(80);
let total = 0;

const LOG2_DIFF1_TARGET = Math.log2(65535) + 208;

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function reverseBytes(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[bytes.length - 1 - i];
  return out;
}

function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function first53(bytes) {
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + bytes[i];
  return n * 32 + (bytes[6] >>> 3);
}

function hashLog2(bytes) {
  let first = 0;
  while (first < bytes.length && bytes[first] === 0) first++;
  if (first === bytes.length) return -Infinity;
  const take = Math.min(7, bytes.length - first);
  let prefix = 0;
  for (let i = 0; i < take; i++) prefix = prefix * 256 + bytes[first + i];
  const remainingBytes = bytes.length - first - take;
  return Math.log2(prefix) + remainingBytes * 8;
}

function difficultyFromHash(bytes) {
  const log2Hash = hashLog2(bytes);
  if (!Number.isFinite(log2Hash)) return Number.POSITIVE_INFINITY;
  const log2Diff = LOG2_DIFF1_TARGET - log2Hash;
  if (log2Diff > 1023) return Number.POSITIVE_INFINITY;
  if (log2Diff < -1074) return 0;
  return Math.pow(2, log2Diff);
}

function setNonceLE(value) {
  header[76] = value & 0xff;
  header[77] = (value >>> 8) & 0xff;
  header[78] = (value >>> 16) & 0xff;
  header[79] = (value >>> 24) & 0xff;
}

function reseed() {
  crypto.getRandomValues(header);
  header[0] = 0x00; header[1] = 0x00; header[2] = 0x00; header[3] = 0x20;
  nonce = ((workerId + 1) * 0x1f123bb5) >>> 0;
}

function runBatch() {
  if (!running) return;
  const started = performance.now();
  const second = Math.floor(Date.now() / 1000);
  const prefixes = new Float64Array(batchSize);
  let bestBytes = null;
  let worstBytes = null;
  let bestDiff = 0;
  let worstDiff = Number.POSITIVE_INFINITY;

  for (let i = 0; i < batchSize; i++) {
    setNonceLE(nonce);
    const digest = Sha256d.doubleSha256(header);
    const displayHash = reverseBytes(digest);
    prefixes[i] = first53(displayHash);

    if (!bestBytes || compareBytes(displayHash, bestBytes) < 0) {
      bestBytes = displayHash.slice();
      bestDiff = difficultyFromHash(displayHash);
    }
    if (!worstBytes || compareBytes(displayHash, worstBytes) > 0) {
      worstBytes = displayHash.slice();
      worstDiff = difficultyFromHash(displayHash);
    }

    nonce = (nonce + 1) >>> 0;
    total++;
    if (nonce === 0) reseed();
  }

  const elapsedMs = performance.now() - started;
  postMessage({
    type: 'batch', workerId, second, count: batchSize, elapsedMs,
    bestHash: bytesToHex(bestBytes), bestDifficulty: bestDiff,
    worstHash: bytesToHex(worstBytes), worstDifficulty: worstDiff,
    total, prefixes: prefixes.buffer
  }, [prefixes.buffer]);

  setTimeout(runBatch, 0);
}

onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'start') {
    workerId = Number(msg.workerId || 0);
    batchSize = Math.max(16, Math.min(4096, Number(msg.batchSize || 256)));
    if (msg.seed && msg.seed.byteLength === 80) header = new Uint8Array(msg.seed);
    else reseed();
    running = true;
    runBatch();
  } else if (msg.type === 'pause') {
    running = false;
  } else if (msg.type === 'resume') {
    if (!running) { running = true; runBatch(); }
  } else if (msg.type === 'stop') {
    running = false;
    close();
  } else if (msg.type === 'batch-size') {
    batchSize = Math.max(16, Math.min(4096, Number(msg.batchSize || batchSize)));
  }
};
