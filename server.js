'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const { StratumMiner } = require('./lib/stratum-miner');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8791);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATE_FILE = path.join(ROOT, '.miner-state.json');
const DEFAULT_ADDRESS = 'bc1qjuf2d7s5mfukj50pd48ruk6asxqy7c4rtgx0sx';
const MAX_RECORDS = 1000;
const ALLOWED_POOLS = new Set([
  'stratum+tcp://solo.stratum.braiins.com:3333',
  'stratum+tcp://solo.stratum.braiins.com:443',
  'stratum+tcp://solo.stratum.braiins.com:25'
]);

let miner = null;
let sseClients = new Set();
let logBuffer = [];
let saveTimer = null;
let networkCache = { at: 0, payload: null };
const secondBuckets = new Map();
const shareEvidence = new Map();
let state = initialState(loadPersisted());

function emptyHistory() {
  return {
    lifetimeHashes: 0,
    records: [],
    bestRecord: null,
    worstRecord: null,
    currentBlock: null
  };
}

function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      lifetimeHashes: Math.max(0, Number(raw.lifetimeHashes) || 0),
      records: Array.isArray(raw.records) ? raw.records.slice(-MAX_RECORDS) : [],
      bestRecord: raw.bestRecord || null,
      worstRecord: raw.worstRecord || null,
      currentBlock: raw.currentBlock || null
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not load ${STATE_FILE}: ${error.message}`);
    return emptyHistory();
  }
}

function historyFromState() {
  return {
    lifetimeHashes: state.lifetimeHashes,
    records: state.records,
    bestRecord: state.bestRecord,
    worstRecord: state.worstRecord,
    currentBlock: state.currentBlock
  };
}

function initialState(history = emptyHistory()) {
  return {
    running: false,
    startedAt: null,
    stoppedAt: null,
    address: DEFAULT_ADDRESS,
    worker: 'ricky',
    pool: 'stratum+tcp://solo.stratum.braiins.com:3333',
    threads: 1,
    connected: false,
    subscribed: false,
    authorized: false,
    submissionReady: false,
    jobId: null,
    jobReceivedAt: null,
    generation: null,
    currentWork: null,
    hashrateHps: 0,
    sessionHashes: 0,
    lifetimeHashes: Math.max(0, Number(history.lifetimeHashes) || 0),
    accepted: 0,
    rejected: 0,
    sharesSubmitted: 0,
    poolDifficulty: null,
    networkDifficulty: null,
    networkTarget: null,
    bestHash: history.bestRecord?.hash || null,
    bestShareDifficulty: Number(history.bestRecord?.difficulty) || 0,
    worstHash: history.worstRecord?.hash || null,
    worstDifficulty: Number(history.worstRecord?.difficulty) || null,
    closestPercent: 0,
    blockCandidates: 0,
    acceptedBlockCandidates: 0,
    records: Array.isArray(history.records) ? history.records.slice(-MAX_RECORDS) : [],
    bestRecord: history.bestRecord || null,
    worstRecord: history.worstRecord || null,
    currentBlock: history.currentBlock || null,
    observedNetworkHeight: null,
    observedNetworkTipHash: null,
    lastLine: '',
    error: null
  };
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = JSON.stringify({
      schemaVersion: 1,
      lifetimeHashes: state.lifetimeHashes,
      records: state.records.slice(-MAX_RECORDS),
      bestRecord: state.bestRecord,
      worstRecord: state.worstRecord,
      currentBlock: state.currentBlock
    }, null, 2);
    const temporary = `${STATE_FILE}.tmp`;
    try {
      fs.writeFileSync(temporary, payload, { mode: 0o600 });
      fs.renameSync(temporary, STATE_FILE);
    } catch (error) {
      console.warn(`Could not save mining records: ${error.message}`);
    }
  }, 750);
  saveTimer.unref?.();
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(payload);
}

function readJson(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let rejected = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (rejected) return;
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) {
        rejected = true;
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function bech32HrpExpand(hrp) {
  const output = [];
  for (const character of hrp) output.push(character.charCodeAt(0) >>> 5);
  output.push(0);
  for (const character of hrp) output.push(character.charCodeAt(0) & 31);
  return output;
}

function validateBech32Address(value) {
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) return false;
  const lower = value.toLowerCase();
  const separator = lower.lastIndexOf('1');
  if (separator < 1 || separator + 7 > lower.length) return false;
  const hrp = lower.slice(0, separator);
  if (hrp !== 'bc') return false;
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = [];
  for (const character of lower.slice(separator + 1)) {
    const index = alphabet.indexOf(character);
    if (index < 0) return false;
    data.push(index);
  }
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  if (polymod !== 1 && polymod !== 0x2bc830a3) return false;
  const witnessVersion = data[0];
  if (witnessVersion > 16) return false;
  if (witnessVersion === 0 && polymod !== 1) return false;
  if (witnessVersion !== 0 && polymod !== 0x2bc830a3) return false;
  return true;
}

function decodeBase58(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let decoded = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  if (leadingZeroes) decoded = Buffer.concat([Buffer.alloc(leadingZeroes), decoded]);
  return decoded;
}

function validateBase58Address(value) {
  const decoded = decodeBase58(value);
  if (!decoded || decoded.length !== 25) return false;
  if (decoded[0] !== 0x00 && decoded[0] !== 0x05) return false;
  const body = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const first = crypto.createHash('sha256').update(body).digest();
  const expected = crypto.createHash('sha256').update(first).digest().subarray(0, 4);
  return crypto.timingSafeEqual(checksum, expected);
}

function validateBitcoinAddress(address) {
  if (typeof address !== 'string') return false;
  const value = address.trim();
  if (value.length < 14 || value.length > 90) return false;
  if (/^bc1/i.test(value)) return validateBech32Address(value);
  return validateBase58Address(value);
}

function addLog(source, line) {
  const clean = String(line).trim();
  if (!clean) return;
  state.lastLine = clean;
  const entry = { at: new Date().toISOString(), source, line: clean };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  broadcast('log', entry);
}

function compareHash(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function evidenceKey(jobId, hash) {
  return `${jobId || ''}:${hash || ''}`;
}

function rewardEligibility() {
  if (!state.running) return { eligible: false, reason: 'Miner stopped' };
  if (!state.connected) return { eligible: false, reason: 'Waiting for pool connection' };
  if (!state.subscribed) return { eligible: false, reason: 'Waiting for Stratum subscription' };
  if (!state.authorized) return { eligible: false, reason: 'Waiting for pool authorization' };
  if (!state.jobId) return { eligible: false, reason: 'Waiting for a live Bitcoin job' };
  if (!state.networkTarget || !state.currentWork) return { eligible: false, reason: 'Live job is not fully constructed' };
  if (!state.submissionReady) return { eligible: false, reason: 'Submission path is not ready' };
  return { eligible: true, reason: 'Authorized live Stratum work with an active submission path' };
}

function ensureBucket(second) {
  if (!secondBuckets.has(second)) {
    secondBuckets.set(second, {
      second,
      count: 0,
      segments: [],
      best: null,
      worst: null,
      median: null,
      dirty: true
    });
  }
  return secondBuckets.get(second);
}

function computeMedian(bucket) {
  if (!bucket || !bucket.count) return null;
  if (!bucket.dirty && bucket.median != null) return bucket.median;
  const values = new Float64Array(bucket.count);
  let offset = 0;
  for (const segment of bucket.segments) {
    values.set(segment, offset);
    offset += segment.length;
  }
  values.sort();
  const middle = Math.floor(values.length / 2);
  bucket.median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  bucket.dirty = false;
  return bucket.median;
}

function medianSummary(value) {
  if (value == null) return null;
  const aligned = BigInt(Math.floor(value)) << 3n;
  return {
    percentile: (value / Math.pow(2, 53)) * 100,
    approximateHashPrefix: aligned.toString(16).padStart(14, '0')
  };
}

function currentSecondStats() {
  const now = Math.floor(Date.now() / 1000);
  const bucket = secondBuckets.get(now) || secondBuckets.get(now - 1) || [...secondBuckets.values()].at(-1);
  if (!bucket) return null;
  return {
    second: bucket.second,
    count: bucket.count,
    best: bucket.best,
    worst: bucket.worst,
    median: medianSummary(computeMedian(bucket))
  };
}

function aggregateSecond(batch) {
  const bucket = ensureBucket(Number(batch.second));
  const prefixes = batch.prefixes instanceof ArrayBuffer
    ? new Float64Array(batch.prefixes)
    : ArrayBuffer.isView(batch.prefixes)
      ? new Float64Array(batch.prefixes.buffer, batch.prefixes.byteOffset, batch.prefixes.byteLength / 8)
      : new Float64Array(0);
  bucket.count += Number(batch.hashes || 0);
  bucket.segments.push(new Float64Array(prefixes));
  bucket.dirty = true;

  if (batch.bestHashHex && (!bucket.best || compareHash(batch.bestHashHex, bucket.best.hash) < 0)) {
    bucket.best = {
      hash: batch.bestHashHex,
      difficulty: Number(batch.bestDifficulty) || 0,
      nonce: batch.bestNonce,
      workerId: batch.workerId
    };
  }
  if (batch.worstHashHex && (!bucket.worst || compareHash(batch.worstHashHex, bucket.worst.hash) > 0)) {
    bucket.worst = {
      hash: batch.worstHashHex,
      difficulty: Number(batch.worstDifficulty) || 0,
      nonce: batch.worstNonce,
      workerId: batch.workerId
    };
  }

  const cutoff = Math.floor(Date.now() / 1000) - 3;
  for (const key of secondBuckets.keys()) {
    if (key < cutoff) secondBuckets.delete(key);
  }
}

function ensureCurrentBlock(batch = null) {
  if (!state.currentBlock) {
    state.currentBlock = {
      key: null,
      prevhash: null,
      jobId: batch?.jobId || state.jobId,
      startedAt: Date.now(),
      hashes: 0,
      best: null,
      worst: null
    };
  }
  return state.currentBlock;
}

function createRecord(candidate, batch, counts) {
  const previous = state.bestRecord;
  const evidence = shareEvidence.get(evidenceKey(batch.jobId, candidate.hash)) || {};
  const difficulty = Number(candidate.difficulty) || 0;
  const networkDifficulty = Number(batch.networkDifficulty) || null;
  const meetsNetworkDifficulty = Boolean(networkDifficulty && difficulty >= networkDifficulty);
  const at = Number(candidate.foundAt) || Date.now();

  return {
    schemaVersion: 3,
    id: `${at}-${candidate.hash.slice(0, 16)}`,
    at,
    timestamp: new Date(at).toISOString(),
    hash: candidate.hash,
    difficulty,
    previousHash: previous?.hash || null,
    previousDifficulty: previous?.difficulty ?? null,
    previousAt: previous?.at ?? null,
    improvementMultiplier: previous?.difficulty > 0 ? difficulty / previous.difficulty : null,
    networkDifficulty,
    networkTarget: batch.networkTarget || null,
    targetPercentage: networkDifficulty ? (difficulty / networkDifficulty) * 100 : null,
    poolDifficulty: Number(batch.poolDifficulty) || null,
    shareTarget: batch.shareTarget || null,
    sessionHashes: counts.sessionHashes,
    lifetimeHashes: counts.lifetimeHashes,
    currentBlockHashes: counts.currentBlockHashes,
    jobId: batch.jobId,
    networkBlockKey: state.currentBlock?.key || null,
    generation: batch.generation,
    extranonce2: batch.extranonce2,
    ntime: batch.ntime,
    version: batch.version,
    workerId: batch.workerId,
    nonce: candidate.nonce,
    workSource: 'live-stratum-mainnet',
    rewardEligibleAtHash: rewardEligibility().eligible,
    submitted: Boolean(evidence.submitted),
    submissionStatus: evidence.submissionStatus || 'not-submitted-below-pool-target',
    shareAccepted: Boolean(evidence.shareAccepted),
    blockCandidate: Boolean(evidence.blockCandidate || meetsNetworkDifficulty),
    blockCandidateStatus: evidence.blockCandidateStatus || (meetsNetworkDifficulty ? 'candidate-detected-awaiting-submission-result' : 'not-a-network-candidate'),
    meetsNetworkDifficulty,
    hashrate: state.hashrateHps,
    runtimeMs: state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : null
  };
}

function updateRecordFromEvidence(jobId, hash, evidence) {
  const record = state.records.find(item => item.jobId === jobId && item.hash === hash);
  if (!record) return;
  Object.assign(record, {
    submitted: Boolean(evidence.submitted),
    submissionStatus: evidence.submissionStatus,
    shareAccepted: Boolean(evidence.shareAccepted),
    blockCandidate: Boolean(evidence.blockCandidate),
    blockCandidateStatus: evidence.blockCandidateStatus
  });
  if (state.bestRecord?.id === record.id) state.bestRecord = record;
  scheduleSave();
}

function processBatch(batch) {
  aggregateSecond(batch);
  const count = Number(batch.hashes || 0);
  const sessionBefore = state.sessionHashes;
  const lifetimeBefore = state.lifetimeHashes;
  const block = ensureCurrentBlock(batch);
  const blockBefore = Number(block.hashes) || 0;

  const candidates = Array.isArray(batch.recordCandidates)
    ? [...batch.recordCandidates].sort((left, right) => Number(left.offset) - Number(right.offset))
    : [];

  for (const candidate of candidates) {
    if (!candidate.hash || (state.bestRecord && compareHash(candidate.hash, state.bestRecord.hash) >= 0)) continue;
    const offset = Math.max(0, Number(candidate.offset) || 0);
    const record = createRecord(candidate, batch, {
      sessionHashes: sessionBefore + offset + 1,
      lifetimeHashes: lifetimeBefore + offset + 1,
      currentBlockHashes: blockBefore + offset + 1
    });
    state.bestRecord = record;
    state.bestHash = record.hash;
    state.bestShareDifficulty = record.difficulty;
    state.records.push(record);
    state.records = state.records.slice(-MAX_RECORDS);
  }

  if (batch.worstHashHex && (!state.worstRecord || compareHash(batch.worstHashHex, state.worstRecord.hash) > 0)) {
    const offset = Math.max(0, Number(batch.worstOffset) || 0);
    state.worstRecord = {
      hash: batch.worstHashHex,
      difficulty: Number(batch.worstDifficulty) || 0,
      at: Number(batch.worstFoundAt) || Date.now(),
      timestamp: new Date(Number(batch.worstFoundAt) || Date.now()).toISOString(),
      sessionHashes: sessionBefore + offset + 1,
      lifetimeHashes: lifetimeBefore + offset + 1,
      currentBlockHashes: blockBefore + offset + 1,
      jobId: batch.jobId,
      workerId: batch.workerId,
      nonce: batch.worstNonce,
      workSource: 'live-stratum-mainnet'
    };
    state.worstHash = state.worstRecord.hash;
    state.worstDifficulty = state.worstRecord.difficulty;
  }

  if (batch.bestHashHex && (!block.best || compareHash(batch.bestHashHex, block.best.hash) < 0)) {
    block.best = {
      hash: batch.bestHashHex,
      difficulty: Number(batch.bestDifficulty) || 0,
      at: Number(batch.bestFoundAt) || Date.now()
    };
  }
  if (batch.worstHashHex && (!block.worst || compareHash(batch.worstHashHex, block.worst.hash) > 0)) {
    block.worst = {
      hash: batch.worstHashHex,
      difficulty: Number(batch.worstDifficulty) || 0,
      at: Number(batch.worstFoundAt) || Date.now()
    };
  }

  state.sessionHashes += count;
  state.lifetimeHashes += count;
  block.hashes = blockBefore + count;
  scheduleSave();
}

function publicStatus() {
  const eligibility = rewardEligibility();
  return {
    ...state,
    rewardEligible: eligibility.eligible,
    eligibilityReason: eligibility.reason,
    currentSecond: currentSecondStats(),
    records: state.records.slice(-500),
    minerInstalled: true,
    minerPath: 'Built-in Node.js Stratum V1 miner',
    architecture: process.arch,
    platform: process.platform,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    logicalCpus: os.cpus().length,
    defaultAddress: DEFAULT_ADDRESS,
    logs: logBuffer.slice(-80)
  };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

function broadcastStatus() {
  broadcast('status', publicStatus());
}

function resetCurrentBlock(job) {
  const oldKey = state.currentBlock?.key;
  if (oldKey === job.prevhash) {
    state.currentBlock.jobId = job.jobId;
    return;
  }
  state.currentBlock = {
    key: job.prevhash,
    prevhash: job.prevhash,
    jobId: job.jobId,
    startedAt: Number(job.receivedAt) || Date.now(),
    hashes: 0,
    best: null,
    worst: null
  };
  scheduleSave();
}

function startMiner(config) {
  if (miner) throw new Error('Miner is already running');

  const address = String(config.address || '').trim();
  const worker = String(config.worker || 'ricky').trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32) || 'ricky';
  const pool = String(config.pool || '');
  const threads = Math.max(1, Math.min(os.cpus().length, Number.parseInt(config.threads, 10) || 1));

  if (!validateBitcoinAddress(address)) throw new Error('Invalid Bitcoin mainnet payout address');
  if (!ALLOWED_POOLS.has(pool)) throw new Error('Pool is not in the safety allowlist');

  const history = historyFromState();
  state = {
    ...initialState(history),
    running: true,
    startedAt: new Date().toISOString(),
    address,
    worker,
    pool,
    threads
  };
  logBuffer = [];
  secondBuckets.clear();
  shareEvidence.clear();

  miner = new StratumMiner({
    pool,
    username: `${address}.${worker}`,
    password: 'x',
    threads,
    chunkSize: 2048
  });

  miner.on('log', line => addLog('miner', line));
  miner.on('status', update => {
    Object.assign(state, update);
    broadcastStatus();
  });
  miner.on('job', job => {
    state.jobId = job.jobId;
    state.jobReceivedAt = job.receivedAt;
    state.networkDifficulty = job.networkDifficulty;
    state.networkTarget = job.networkTarget;
    resetCurrentBlock(job);
    broadcastStatus();
  });
  miner.on('work', work => {
    state.currentWork = work;
    state.generation = work.generation;
    state.poolDifficulty = work.poolDifficulty;
    state.networkDifficulty = work.networkDifficulty;
    state.networkTarget = work.networkTarget;
    broadcastStatus();
  });
  miner.on('batch', batch => processBatch(batch));
  miner.on('progress', update => {
    state.hashrateHps = update.hashrateHps;
    state.bestHash = state.bestRecord?.hash || update.bestHash;
    state.bestShareDifficulty = state.bestRecord?.difficulty || update.bestDifficulty;
    state.worstHash = state.worstRecord?.hash || update.worstHash;
    state.worstDifficulty = state.worstRecord?.difficulty || update.worstDifficulty;
    state.closestPercent = update.closestPercent;
    state.networkDifficulty = update.networkDifficulty;
    state.networkTarget = update.networkTarget;
    state.poolDifficulty = update.poolDifficulty;
    broadcastStatus();
  });
  miner.on('share', share => {
    if (share.sent) state.sharesSubmitted += 1;
    if (share.blockCandidate) state.blockCandidates += 1;
    const evidence = {
      submitted: Boolean(share.sent),
      submissionStatus: share.sent ? 'submitted-awaiting-pool-response' : 'submission-send-failed',
      shareAccepted: false,
      blockCandidate: Boolean(share.blockCandidate),
      blockCandidateStatus: share.blockCandidate
        ? (share.sent ? 'submitted-candidate-awaiting-pool-response' : 'candidate-send-failed')
        : 'not-a-network-candidate'
    };
    shareEvidence.set(evidenceKey(share.jobId, share.hashHex), evidence);
    updateRecordFromEvidence(share.jobId, share.hashHex, evidence);
    broadcastStatus();
  });
  miner.on('submission', result => {
    if (result.accepted) state.accepted += 1;
    else state.rejected += 1;
    if (result.accepted && result.blockCandidate) state.acceptedBlockCandidates += 1;
    const evidence = {
      submitted: result.error !== 'socket-not-writable',
      submissionStatus: result.accepted ? 'accepted-by-pool' : `rejected-or-unconfirmed:${result.error || 'pool-rejected'}`,
      shareAccepted: Boolean(result.accepted),
      blockCandidate: Boolean(result.blockCandidate),
      blockCandidateStatus: result.blockCandidate
        ? (result.accepted ? 'pool-accepted-candidate-network-confirmation-pending' : 'candidate-rejected-or-unconfirmed')
        : 'not-a-network-candidate'
    };
    shareEvidence.set(evidenceKey(result.jobId, result.hashHex), evidence);
    updateRecordFromEvidence(result.jobId, result.hashHex, evidence);
    broadcastStatus();
  });

  addLog('system', `Starting live Stratum miner with ${threads} CPU thread(s).`);
  miner.start();
  return publicStatus();
}

async function stopMiner() {
  if (!miner) return publicStatus();
  addLog('system', 'Stopping miner…');
  const current = miner;
  miner = null;
  await current.stop();
  state.running = false;
  state.connected = false;
  state.subscribed = false;
  state.authorized = false;
  state.submissionReady = false;
  state.currentWork = null;
  state.stoppedAt = new Date().toISOString();
  state.hashrateHps = 0;
  addLog('system', 'Miner stopped.');
  scheduleSave();
  broadcastStatus();
  return publicStatus();
}

async function fetchText(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RickyMinerReward/8.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

async function networkPayload() {
  const now = Date.now();
  if (networkCache.payload && now - networkCache.at < 15000) return networkCache.payload;
  let height = null;
  let tipHash = null;
  try {
    [height, tipHash] = await Promise.all([
      fetchText('https://mempool.space/api/blocks/tip/height'),
      fetchText('https://mempool.space/api/blocks/tip/hash')
    ]);
    height = Number(height);
    if (!Number.isInteger(height)) height = null;
  } catch (_) {}
  state.observedNetworkHeight = height;
  state.observedNetworkTipHash = tipHash;
  const payload = {
    difficulty: state.networkDifficulty,
    networkHashrate: state.networkDifficulty ? state.networkDifficulty * 4294967296 / 600 : null,
    height,
    tipHash,
    source: height != null || tipHash ? 'mempool.space' : 'live Stratum target only',
    fetchedAt: now
  };
  networkCache = { at: now, payload };
  return payload;
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };
    res.writeHead(200, {
      'Content-Type': types[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, 200, publicStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/network') {
    json(res, 200, await networkPayload());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/validate-address') {
    try {
      const body = await readJson(req);
      json(res, 200, { valid: validateBitcoinAddress(body.address), address: String(body.address || '').trim() });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/start') {
    try {
      const body = await readJson(req);
      json(res, 200, startMiner(body));
    } catch (error) {
      state.error = error.message;
      addLog('error', error.message);
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    try {
      json(res, 200, await stopMiner());
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/clear-records') {
    try {
      if (miner) throw new Error('Stop mining before clearing records');
      state.records = [];
      state.bestRecord = null;
      state.worstRecord = null;
      state.bestHash = null;
      state.bestShareDifficulty = 0;
      state.worstHash = null;
      state.worstDifficulty = null;
      state.currentBlock = null;
      scheduleSave();
      json(res, 200, publicStatus());
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: status\ndata: ${JSON.stringify(publicStatus())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, url.pathname);
    return;
  }

  res.writeHead(405); res.end('Method not allowed');
});

function shutdown() {
  Promise.resolve(stopMiner()).finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 3000).unref();
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Ricky Bitcoin Reward Miner v8 running at http://${HOST}:${PORT}`);
    console.log('The dashboard shows reward eligibility only after connection, subscription, authorization, live job construction, and submission readiness are all true.');
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  validateBitcoinAddress,
  server,
  initialState,
  rewardEligibility,
  currentSecondStats,
  processBatch
};
