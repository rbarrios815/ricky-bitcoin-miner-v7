'use strict';

const { parentPort } = require('worker_threads');
const crypto = require('crypto');

let active = false;
let work = null;

const LOG2_DIFF1_TARGET = Math.log2(65535) + 208;

function sha256d(buffer) {
  const first = crypto.createHash('sha256').update(buffer).digest();
  return crypto.createHash('sha256').update(first).digest();
}

function hashToDisplay(hash) {
  return Buffer.from(hash).reverse();
}

function displayToValue(display) {
  return BigInt(`0x${display.toString('hex')}`);
}

function first53(display) {
  let number = 0;
  for (let index = 0; index < 6; index += 1) number = number * 256 + display[index];
  return number * 32 + (display[6] >>> 3);
}

function hashLog2(display) {
  let first = 0;
  while (first < display.length && display[first] === 0) first += 1;
  if (first === display.length) return -Infinity;
  const take = Math.min(7, display.length - first);
  let prefix = 0;
  for (let index = 0; index < take; index += 1) prefix = prefix * 256 + display[first + index];
  return Math.log2(prefix) + (display.length - first - take) * 8;
}

function difficultyFromDisplay(display) {
  const log2Hash = hashLog2(display);
  if (!Number.isFinite(log2Hash)) return Number.POSITIVE_INFINITY;
  const exponent = LOG2_DIFF1_TARGET - log2Hash;
  if (exponent > 1023) return Number.POSITIVE_INFINITY;
  if (exponent < -1074) return 0;
  return Math.pow(2, exponent);
}

function mineChunk() {
  if (!active || !work) return;

  const local = work;
  const header = Buffer.allocUnsafe(80);
  Buffer.from(local.headerPrefixHex, 'hex').copy(header, 0);
  const shareTarget = BigInt(`0x${local.shareTargetHex}`);
  const networkTarget = BigInt(`0x${local.networkTargetHex}`);
  const stride = Math.max(1, local.stride >>> 0);
  const chunkSize = Math.max(16, local.chunkSize || 2048);
  const maximumIterations = Math.ceil(0x100000000 / stride);

  let nonce = local.nextNonce >>> 0;
  let hashes = 0;
  let bestValue = null;
  let worstValue = null;
  let bestHashHex = null;
  let worstHashHex = null;
  let bestNonce = nonce;
  let worstNonce = nonce;
  let bestOffset = 0;
  let worstOffset = 0;
  let bestFoundAt = Date.now();
  let worstFoundAt = bestFoundAt;
  const prefixes = new Float64Array(Math.min(chunkSize, maximumIterations - local.iterations));
  const recordCandidates = [];

  for (let index = 0; index < prefixes.length; index += 1) {
    if (!work || local.generation !== work.generation) break;

    const currentNonce = nonce;
    header.writeUInt32LE(currentNonce, 76);
    const rawHash = sha256d(header);
    const display = hashToDisplay(rawHash);
    const value = displayToValue(display);
    const hashHex = display.toString('hex');
    const difficulty = difficultyFromDisplay(display);
    const foundAt = Date.now();

    prefixes[index] = first53(display);
    hashes += 1;

    if (bestValue === null || value < bestValue) {
      bestValue = value;
      bestHashHex = hashHex;
      bestNonce = currentNonce;
      bestOffset = index;
      bestFoundAt = foundAt;
      recordCandidates.push({
        hash: hashHex,
        hashValueHex: value.toString(16).padStart(64, '0'),
        difficulty,
        nonce: currentNonce,
        offset: index,
        foundAt
      });
    }

    if (worstValue === null || value > worstValue) {
      worstValue = value;
      worstHashHex = hashHex;
      worstNonce = currentNonce;
      worstOffset = index;
      worstFoundAt = foundAt;
    }

    if (value <= shareTarget) {
      parentPort.postMessage({
        type: 'share',
        generation: local.generation,
        workerId: local.workerId,
        jobId: local.jobId,
        extranonce2: local.extranonce2,
        ntime: local.ntime,
        nonce: currentNonce,
        nonceHex: currentNonce.toString(16).padStart(8, '0'),
        hashHex,
        hashValueHex: value.toString(16).padStart(64, '0'),
        difficulty,
        blockCandidate: value <= networkTarget,
        foundAt
      });
    }

    nonce = (nonce + stride) >>> 0;
  }

  if (work && local.generation === work.generation) {
    work.nextNonce = nonce;
    work.iterations += hashes;
  }

  const exactPrefixes = hashes === prefixes.length ? prefixes : prefixes.slice(0, hashes);
  parentPort.postMessage({
    type: 'batch',
    generation: local.generation,
    workerId: local.workerId,
    jobId: local.jobId,
    extranonce2: local.extranonce2,
    ntime: local.ntime,
    version: local.version,
    second: Math.floor(Date.now() / 1000),
    hashes,
    bestHashHex,
    bestValueHex: bestValue === null ? null : bestValue.toString(16).padStart(64, '0'),
    bestDifficulty: bestValue === null ? 0 : difficultyFromDisplay(Buffer.from(bestHashHex, 'hex')),
    bestNonce,
    bestOffset,
    bestFoundAt,
    worstHashHex,
    worstValueHex: worstValue === null ? null : worstValue.toString(16).padStart(64, '0'),
    worstDifficulty: worstValue === null ? null : difficultyFromDisplay(Buffer.from(worstHashHex, 'hex')),
    worstNonce,
    worstOffset,
    worstFoundAt,
    recordCandidates,
    prefixes: exactPrefixes.buffer
  }, [exactPrefixes.buffer]);

  if (active && work && work.iterations >= maximumIterations) {
    active = false;
    parentPort.postMessage({
      type: 'exhausted',
      generation: local.generation,
      workerId: local.workerId,
      jobId: local.jobId
    });
    return;
  }

  if (active && work) setImmediate(mineChunk);
}

parentPort.on('message', message => {
  if (message.type === 'start') {
    work = { ...message.work, iterations: 0 };
    active = true;
    setImmediate(mineChunk);
  } else if (message.type === 'stop') {
    active = false;
    work = null;
  }
});
