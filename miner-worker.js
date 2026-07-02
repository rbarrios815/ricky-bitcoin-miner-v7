'use strict';
importScripts('sha256.js');

let running = false;
let batchSize = 256;
let workerId = 0;
let nonce = 0;
let header = new Uint8Array(80);
let total = 0;
let sessionId = 'session';
let jobId = 'local-job';

const LOG2_DIFF1_TARGET = Math.log2(65535) + 208;

function bytesToHex(bytes) {
  let value = '';
  for (let index = 0; index < bytes.length; index += 1) {
    value += bytes[index].toString(16).padStart(2, '0');
  }
  return value;
}

function reverseBytes(bytes) {
  const output = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    output[index] = bytes[bytes.length - 1 - index];
  }
  return output;
}

function compareBytes(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function first53(bytes) {
  let number = 0;
  for (let index = 0; index < 6; index += 1) number = number * 256 + bytes[index];
  return number * 32 + (bytes[6] >>> 3);
}

function hashLog2(bytes) {
  let first = 0;
  while (first < bytes.length && bytes[first] === 0) first += 1;
  if (first === bytes.length) return -Infinity;
  const take = Math.min(7, bytes.length - first);
  let prefix = 0;
  for (let index = 0; index < take; index += 1) prefix = prefix * 256 + bytes[first + index];
  const remainingBytes = bytes.length - first - take;
  return Math.log2(prefix) + remainingBytes * 8;
}

function difficultyFromHash(bytes) {
  const log2Hash = hashLog2(bytes);
  if (!Number.isFinite(log2Hash)) return Number.POSITIVE_INFINITY;
  const log2Difficulty = LOG2_DIFF1_TARGET - log2Hash;
  if (log2Difficulty > 1023) return Number.POSITIVE_INFINITY;
  if (log2Difficulty < -1074) return 0;
  return Math.pow(2, log2Difficulty);
}

function setNonceLE(value) {
  header[76] = value & 0xff;
  header[77] = (value >>> 8) & 0xff;
  header[78] = (value >>> 16) & 0xff;
  header[79] = (value >>> 24) & 0xff;
}

function refreshJobId() {
  const sessionPrefix = String(sessionId || 'session').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
  jobId = `local-${sessionPrefix || 'session'}-w${workerId}-${bytesToHex(header.slice(4, 12))}`;
}

function applySyntheticVersion() {
  header[0] = 0x00;
  header[1] = 0x00;
  header[2] = 0x00;
  header[3] = 0x20;
}

function reseed() {
  crypto.getRandomValues(header);
  applySyntheticVersion();
  nonce = ((workerId + 1) * 0x1f123bb5) >>> 0;
  refreshJobId();
}

function runBatch() {
  if (!running) return;

  const started = performance.now();
  const second = Math.floor(Date.now() / 1000);
  const prefixes = new Float64Array(batchSize);
  const recordCandidates = [];

  let bestBytes = null;
  let worstBytes = null;
  let bestDifficulty = 0;
  let worstDifficulty = Number.POSITIVE_INFINITY;
  let bestOffset = 0;
  let worstOffset = 0;
  let bestFoundAt = Date.now();
  let worstFoundAt = bestFoundAt;
  let bestNonce = nonce;
  let worstNonce = nonce;

  for (let index = 0; index < batchSize; index += 1) {
    const currentNonce = nonce;
    setNonceLE(currentNonce);
    const digest = Sha256d.doubleSha256(header);
    const displayHash = reverseBytes(digest);
    const difficulty = difficultyFromHash(displayHash);
    prefixes[index] = first53(displayHash);

    if (!bestBytes || compareBytes(displayHash, bestBytes) < 0) {
      const foundAt = Date.now();
      bestBytes = displayHash.slice();
      bestDifficulty = difficulty;
      bestOffset = index;
      bestFoundAt = foundAt;
      bestNonce = currentNonce;
      recordCandidates.push({
        hash: bytesToHex(bestBytes),
        difficulty,
        offset: index,
        foundAt,
        nonce: currentNonce
      });
    }

    if (!worstBytes || compareBytes(displayHash, worstBytes) > 0) {
      worstBytes = displayHash.slice();
      worstDifficulty = difficulty;
      worstOffset = index;
      worstFoundAt = Date.now();
      worstNonce = currentNonce;
    }

    nonce = (nonce + 1) >>> 0;
    total += 1;
    if (nonce === 0) reseed();
  }

  const elapsedMs = performance.now() - started;
  postMessage({
    type: 'batch',
    workerId,
    jobId,
    second,
    count: batchSize,
    elapsedMs,
    bestHash: bytesToHex(bestBytes),
    bestDifficulty,
    bestOffset,
    bestFoundAt,
    bestNonce,
    worstHash: bytesToHex(worstBytes),
    worstDifficulty,
    worstOffset,
    worstFoundAt,
    worstNonce,
    recordCandidates,
    total,
    prefixes: prefixes.buffer
  }, [prefixes.buffer]);

  setTimeout(runBatch, 0);
}

onmessage = (event) => {
  const message = event.data || {};

  if (message.type === 'start') {
    workerId = Number(message.workerId || 0);
    sessionId = String(message.sessionId || 'session');
    batchSize = Math.max(16, Math.min(4096, Number(message.batchSize || 256)));

    if (message.seed && message.seed.byteLength === 80) {
      header = new Uint8Array(message.seed);
      applySyntheticVersion();
      nonce = ((workerId + 1) * 0x1f123bb5) >>> 0;
      refreshJobId();
    } else {
      reseed();
    }

    running = true;
    runBatch();
  } else if (message.type === 'pause') {
    running = false;
  } else if (message.type === 'resume') {
    if (!running) {
      running = true;
      runBatch();
    }
  } else if (message.type === 'stop') {
    running = false;
    close();
  } else if (message.type === 'batch-size') {
    batchSize = Math.max(16, Math.min(4096, Number(message.batchSize || batchSize)));
  }
};
