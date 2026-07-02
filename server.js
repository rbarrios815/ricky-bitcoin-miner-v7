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
const DEFAULT_ADDRESS = '';
const MAX_RECORDS = 1000;
const HASH_FRESHNESS_MS = 5000;
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
    lastHashBatchAt: null,
    lastHashJobId: null,
    lastHashGeneration: null,
    lastHashCount: 0,
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

function resetHashEvidence() {
  state.lastHashBatchAt = null;
  state.lastHashJobId = null;
  state.lastHashGeneration = null;
  state.lastHashCount = 0;
}

function rewardEligibilityForState(candidate, now = Date.now()) {
  if (!candidate.running) return { eligible: false, reason: 'Miner stopped' };
  if (!candidate.connected) return { eligible: false, reason: 'Waiting for pool connection' };
  if (!candidate.subscribed) return { eligible: false, reason: 'Waiting for Stratum subscription' };
  if (!candidate.authorized) return { eligible: false, reason: 'Waiting for pool authorization' };
  if (!candidate.jobId) return { eligible: false, reason: 'Waiting for a live Bitcoin job' };
  if (!candidate.networkTarget || !candidate.currentWork) return { eligible: false, reason: 'Live job is not fully constructed' };
  if (!candidate.submissionReady) return { eligible: false, reason: 'Submission path is not ready' };
  if (!(Number(candidate.lastHashCount) > 0)) return { eligible: false, reason: 'Waiting for fresh hashing evidence' };
  if (candidate.lastHashJobId !== candidate.jobId) return { eligible: false, reason: 'Waiting for hashing on the current live job' };
  if ((candidate.lastHashGeneration ?? null) !== (candidate.generation ?? null)) {
    return { eligible: false, reason: 'Waiting for hashing on the current job generation' };
  }
  const lastHashBatchAt = Number(candidate.lastHashBatchAt);
  const hashAgeMs = Number(now) - lastHashBatchAt;
  if (!Number.isFinite(lastHashBatchAt) || lastHashBatchAt <= 0 || !Number.isFinite(hashAgeMs) || hashAgeMs < 0 || hashAgeMs > HASH_FRESHNESS_MS) {
    return { eligible: false, reason: 'Waiting for a fresh hash batch' };
  }
  return { eligible: true, reason: 'Authorized live Stratum work with fresh hashing and an active submission path' };
}

function rewardEligibility() {
  return rewardEligibilityForState(state);
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
      : new Float64Array(Array.isArray(batch.prefixes) ? batch.prefixes : []);
  bucket.count += Number(batch.count) || prefixes.length;
  bucket.segments.push(new Float64Array(prefixes));
  bucket.dirty = true;

  const best = batch.bestHash ? {
    hash: batch.bestHash,
    difficulty: Number(batch.bestDifficulty) || 0,
    foundAt: Number(batch.bestFoundAt) || Date.now(),
    nonce: batch.bestNonce
  } : null;
  const worst = batch.worstHash ? {
    hash: batch.worstHash,
    difficulty: Number(batch.worstDifficulty) || 0,
    foundAt: Number(batch.worstFoundAt) || Date.now(),
    nonce: batch.worstNonce
  } : null;

  if (best && (!bucket.best || compareHash(best.hash, bucket.best.hash) < 0)) bucket.best = best;
  if (worst && (!bucket.worst || compareHash(worst.hash, bucket.worst.hash) > 0)) bucket.worst = worst;

  const cutoff = Math.floor(Date.now() / 1000) - 5;
  for (const second of secondBuckets.keys()) {
    if (second < cutoff) secondBuckets.delete(second);
  }
}

function ensureBlockScope(batch) {
  const key = batch.prevhash || state.observedNetworkTipHash || state.jobId || null;
  if (!state.currentBlock || state.currentBlock.key !== key) {
    state.currentBlock = {
      key,
      height: state.observedNetworkHeight,
      startedAt: Date.now(),
      hashes: 0,
      best: null,
      worst: null
    };
  }
  return state.currentBlock;
}

function recordImprovement(difficulty, previousDifficulty) {
  if (!Number.isFinite(difficulty) || !Number.isFinite(previousDifficulty) || previousDifficulty <= 0) return null;
  return difficulty / previousDifficulty;
}

function targetPercentage(difficulty) {
  if (!Number.isFinite(difficulty) || !Number.isFinite(state.networkDifficulty) || state.networkDifficulty <= 0) return null;
  return (difficulty / state.networkDifficulty) * 100;
}

function makeRecord(candidate, batch, counts) {
  const previous = state.bestRecord;
  const eligible = Boolean(batch.rewardEligible);
  return {
    schemaVersion: 1,
    id: `${candidate.foundAt || Date.now()}-${candidate.hash.slice(0, 16)}`,
    at: candidate.foundAt || Date.now(),
    timestamp: new Date(candidate.foundAt || Date.now()).toISOString(),
    hash: candidate.hash,
    difficulty: Number(candidate.difficulty) || 0,
    previousHash: previous?.hash || null,
    previousDifficulty: Number(previous?.difficulty) || null,
    previousAt: Number(previous?.at) || null,
    improvementMultiplier: recordImprovement(Number(candidate.difficulty), Number(previous?.difficulty)),
    networkDifficulty: Number(state.networkDifficulty) || null,
    networkTarget: state.networkTarget || batch.networkTargetHex || null,
    poolDifficulty: Number(state.poolDifficulty) || null,
    poolTarget: batch.shareTargetHex || null,
    targetPercentage: targetPercentage(Number(candidate.difficulty)),
    sessionHashes: counts.sessionHashes,
    lifetimeHashes: counts.lifetimeHashes,
    currentBlockHashes: counts.currentBlockHashes,
    sessionId: batch.sessionId || null,
    workSource: 'live-stratum-mainnet',
    pool: state.pool,
    worker: `${state.address}.${state.worker}`,
    jobId: batch.jobId || null,
    generation: batch.generation ?? null,
    extranonce2: batch.extranonce2 || null,
    ntime: batch.ntime || null,
    version: batch.version || null,
    nbits: batch.nbits || null,
    nonce: candidate.nonce ?? null,
    rewardEligibleAtHash: eligible,
    submitted: false,
    submissionStatus: eligible ? 'not-a-share' : 'ineligible-at-hash',
    shareAccepted: false,
    shareRejected: false,
    blockCandidate: Boolean(candidate.meetsNetworkTarget),
    blockCandidateStatus: candidate.meetsNetworkTarget
      ? eligible ? 'candidate-awaiting-pool-response' : 'candidate-ineligible-at-hash'
      : 'not-a-block-candidate',
    hashrate: Number(batch.hashrateHps) || state.hashrateHps,
    runtimeMs: state.startedAt ? Date.now() - state.startedAt : null
  };
}

function addRecord(candidate, batch, counts) {
  if (!candidate?.hash) return null;
  if (state.bestRecord && compareHash(candidate.hash, state.bestRecord.hash) >= 0) return null;
  const record = makeRecord(candidate, batch, counts);
  state.bestRecord = record;
  state.bestHash = record.hash;
  state.bestShareDifficulty = record.difficulty;
  state.records.push(record);
  state.records = state.records.slice(-MAX_RECORDS);
  if (record.blockCandidate) state.blockCandidates += 1;
  shareEvidence.set(evidenceKey(record.jobId, record.hash), record.id);
  scheduleSave();
  broadcastState();
  return record;
}

function updateWorst(batch, counts) {
  if (!batch.worstHash) return;
  if (state.worstRecord && compareHash(batch.worstHash, state.worstRecord.hash) <= 0) return;
  state.worstRecord = {
    at: batch.worstFoundAt || Date.now(),
    timestamp: new Date(batch.worstFoundAt || Date.now()).toISOString(),
    hash: batch.worstHash,
    difficulty: Number(batch.worstDifficulty) || 0,
    sessionHashes: counts.sessionHashes,
    lifetimeHashes: counts.lifetimeHashes,
    currentBlockHashes: counts.currentBlockHashes,
    jobId: batch.jobId || null,
    generation: batch.generation ?? null,
    extranonce2: batch.extranonce2 || null,
    ntime: batch.ntime || null,
    nonce: batch.worstNonce ?? null,
    rewardEligibleAtHash: Boolean(batch.rewardEligible)
  };
  state.worstHash = batch.worstHash;
  state.worstDifficulty = Number(batch.worstDifficulty) || 0;
  scheduleSave();
}

function applyHashBatch(batch) {
  aggregateSecond(batch);
  const block = ensureBlockScope(batch);
  const sessionBefore = state.sessionHashes;
  const lifetimeBefore = state.lifetimeHashes;
  const blockBefore = Number(block.hashes) || 0;
  const count = Number(batch.count) || 0;
  const sameJob = Boolean(state.jobId) && batch.jobId === state.jobId;
  const sameGeneration = (batch.generation ?? null) === (state.generation ?? null);
  if (count > 0 && sameJob && sameGeneration) {
    state.lastHashBatchAt = Date.now();
    state.lastHashJobId = batch.jobId;
    state.lastHashGeneration = batch.generation ?? null;
    state.lastHashCount = count;
  }

  const candidates = Array.isArray(batch.recordCandidates)
    ? [...batch.recordCandidates].sort((left, right) => Number(left.offset) - Number(right.offset))
    : batch.bestHash ? [{
        hash: batch.bestHash,
        difficulty: batch.bestDifficulty,
        offset: batch.bestOffset,
        foundAt: batch.bestFoundAt,
        nonce: batch.bestNonce,
        meetsShareTarget: batch.bestMeetsShareTarget,
        meetsNetworkTarget: batch.bestMeetsNetworkTarget
      }] : [];

  for (const candidate of candidates) {
    const offset = Math.max(0, Number(candidate.offset) || 0);
    addRecord(candidate, batch, {
      sessionHashes: sessionBefore + offset + 1,
      lifetimeHashes: lifetimeBefore + offset + 1,
      currentBlockHashes: blockBefore + offset + 1
    });
  }

  updateWorst(batch, {
    sessionHashes: sessionBefore + Math.max(0, Number(batch.worstOffset) || count - 1) + 1,
    lifetimeHashes: lifetimeBefore + Math.max(0, Number(batch.worstOffset) || count - 1) + 1,
    currentBlockHashes: blockBefore + Math.max(0, Number(batch.worstOffset) || count - 1) + 1
  });

  state.sessionHashes += count;
  state.lifetimeHashes += count;
  block.hashes = blockBefore + count;
  state.hashrateHps = Number(batch.hashrateHps) || state.hashrateHps;

  const best = batch.bestHash ? {
    hash: batch.bestHash,
    difficulty: Number(batch.bestDifficulty) || 0,
    at: batch.bestFoundAt || Date.now()
  } : null;
  const worst = batch.worstHash ? {
    hash: batch.worstHash,
    difficulty: Number(batch.worstDifficulty) || 0,
    at: batch.worstFoundAt || Date.now()
  } : null;
  if (best && (!block.best || compareHash(best.hash, block.best.hash) < 0)) block.best = best;
  if (worst && (!block.worst || compareHash(worst.hash, block.worst.hash) > 0)) block.worst = worst;

  if (Number.isFinite(state.networkDifficulty) && state.networkDifficulty > 0) {
    state.closestPercent = (state.bestShareDifficulty / state.networkDifficulty) * 100;
  }
  scheduleSave();
  broadcastState();
}

function findRecordById(id) {
  return state.records.find(record => record.id === id) || null;
}

function markShareSubmitted(event) {
  state.sharesSubmitted += 1;
  const recordId = shareEvidence.get(evidenceKey(event.jobId, event.hash));
  const record = findRecordById(recordId);
  if (record) {
    record.submitted = true;
    record.submissionStatus = 'submitted-awaiting-response';
    record.submittedAt = Date.now();
    record.shareRequestId = event.requestId;
  }
  scheduleSave();
  broadcastState();
}

function markShareResult(event) {
  if (event.accepted) state.accepted += 1;
  else state.rejected += 1;
  const recordId = shareEvidence.get(evidenceKey(event.jobId, event.hash));
  const record = findRecordById(recordId);
  if (record) {
    record.submitted = true;
    record.submissionStatus = event.accepted ? 'accepted-by-pool' : 'rejected-by-pool';
    record.shareAccepted = Boolean(event.accepted);
    record.shareRejected = !event.accepted;
    record.poolResponse = event.error || null;
    record.respondedAt = Date.now();
    if (record.blockCandidate) {
      record.blockCandidateStatus = event.accepted ? 'candidate-accepted-by-pool' : 'candidate-rejected-by-pool';
      if (event.accepted) state.acceptedBlockCandidates += 1;
    }
  }
  scheduleSave();
  broadcastState();
}

function publicState() {
  const eligibility = rewardEligibility();
  return {
    ...state,
    logicalCpus: os.cpus().length || 1,
    records: state.records.slice(-500),
    currentSecond: currentSecondStats(),
    eligibility,
    logs: logBuffer.slice(-100)
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

function broadcastState() {
  broadcast('state', publicState());
}

function stopMiner(reason = 'Stopped') {
  if (miner) {
    try { miner.stop(); } catch (_) {}
    miner.removeAllListeners();
    miner = null;
  }
  state.running = false;
  state.connected = false;
  state.subscribed = false;
  state.authorized = false;
  state.submissionReady = false;
  state.hashrateHps = 0;
  resetHashEvidence();
  state.stoppedAt = Date.now();
  state.error = reason === 'Stopped' ? null : reason;
  addLog('server', reason);
  broadcastState();
}

function startMiner(config) {
  if (!validateBitcoinAddress(config.address)) throw new Error('Enter a valid Bitcoin mainnet payout address.');
  if (!ALLOWED_POOLS.has(config.pool)) throw new Error('Pool endpoint is not allowed.');
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(config.worker)) throw new Error('Worker name must use 1–32 letters, numbers, underscores, or hyphens.');
  const threads = Math.max(1, Math.min(os.cpus().length || 1, Number(config.threads) || 1));

  stopMiner('Restarting with requested settings');
  secondBuckets.clear();
  shareEvidence.clear();
  state = initialState(historyFromState());
  Object.assign(state, {
    running: true,
    startedAt: Date.now(),
    stoppedAt: null,
    address: config.address.trim(),
    worker: config.worker.trim(),
    pool: config.pool,
    threads,
    error: null
  });

  miner = new StratumMiner({
    pool: config.pool,
    username: `${state.address}.${state.worker}`,
    password: 'x',
    threads,
    reconnect: true
  });

  miner.on('log', line => addLog('miner', line));
  miner.on('connection', connected => {
    state.connected = connected;
    if (!connected) {
      state.subscribed = false;
      state.authorized = false;
      state.submissionReady = false;
      state.jobId = null;
      state.currentWork = null;
      resetHashEvidence();
    }
    broadcastState();
  });
  miner.on('subscribed', subscribed => {
    state.subscribed = subscribed;
    broadcastState();
  });
  miner.on('authorized', authorized => {
    state.authorized = authorized;
    if (!authorized) state.submissionReady = false;
    broadcastState();
  });
  miner.on('submission-ready', ready => {
    state.submissionReady = ready;
    broadcastState();
  });
  miner.on('job', job => {
    resetHashEvidence();
    state.jobId = job.jobId;
    state.jobReceivedAt = Date.now();
    state.generation = job.generation;
    state.currentWork = job;
    state.networkTarget = job.networkTargetHex;
    const nbitsDifficulty = Number(job.networkDifficulty);
    if (Number.isFinite(nbitsDifficulty) && nbitsDifficulty > 0) state.networkDifficulty = nbitsDifficulty;
    ensureBlockScope(job);
    addLog('stratum', `Live job ${job.jobId} generation ${job.generation} received.`);
    broadcastState();
  });
  miner.on('difficulty', difficulty => {
    state.poolDifficulty = Number(difficulty) || null;
    broadcastState();
  });
  miner.on('hashrate', hashrate => {
    state.hashrateHps = Number(hashrate) || 0;
    broadcastState();
  });
  miner.on('hash-batch', applyHashBatch);
  miner.on('share-submitted', markShareSubmitted);
  miner.on('share-result', markShareResult);
  miner.on('error', error => {
    state.error = error.message;
    addLog('error', error.message);
    broadcastState();
  });
  miner.on('stopped', () => {
    state.running = false;
    state.connected = false;
    state.subscribed = false;
    state.authorized = false;
    state.submissionReady = false;
    state.hashrateHps = 0;
    resetHashEvidence();
    broadcastState();
  });

  addLog('server', `Starting ${threads} CPU thread${threads === 1 ? '' : 's'} for ${state.pool}.`);
  miner.start();
  broadcastState();
}

async function fetchJsonOrText(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RickyRewardMinerV8/1.0' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try { return JSON.parse(text); } catch (_) { return text.trim(); }
  } finally {
    clearTimeout(timer);
  }
}

async function observedNetwork() {
  const now = Date.now();
  if (networkCache.payload && now - networkCache.at < 15000) return networkCache.payload;
  let height = null;
  let tipHash = null;
  let difficulty = state.networkDifficulty;
  const sources = [];
  try {
    const mining = await fetchJsonOrText('https://mempool.space/api/v1/mining/hashrate/1m');
    if (mining && typeof mining === 'object') {
      difficulty = Number(mining.currentDifficulty || mining.difficulty) || difficulty;
      sources.push('mempool.space');
    }
  } catch (_) {}
  try {
    height = Number(await fetchJsonOrText('https://mempool.space/api/blocks/tip/height')) || null;
    tipHash = String(await fetchJsonOrText('https://mempool.space/api/blocks/tip/hash') || '') || null;
    if (!sources.includes('mempool.space')) sources.push('mempool.space');
  } catch (_) {}
  if (height == null) {
    try {
      height = Number(await fetchJsonOrText('https://blockchain.info/q/getblockcount')) || null;
      sources.push('blockchain.info');
    } catch (_) {}
  }
  if (!Number.isFinite(difficulty) || difficulty <= 0) {
    try {
      difficulty = Number(await fetchJsonOrText('https://blockchain.info/q/getdifficulty')) || null;
      sources.push('blockchain.info');
    } catch (_) {}
  }
  state.observedNetworkHeight = height;
  state.observedNetworkTipHash = tipHash;
  if (Number.isFinite(difficulty) && difficulty > 0) state.networkDifficulty = difficulty;
  const payload = {
    height,
    tipHash,
    difficulty: Number.isFinite(difficulty) ? difficulty : null,
    networkHashrate: Number.isFinite(difficulty) ? difficulty * (2 ** 32) / 600 : null,
    sources,
    fetchedAt: now
  };
  networkCache = { at: now, payload };
  return payload;
}

function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  }[extension] || 'application/octet-stream';
}

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname); }
  catch (_) { return json(res, 400, { error: 'Bad URL' }); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (file !== PUBLIC_DIR && !file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (error, data) => {
    if (error) return json(res, error.code === 'ENOENT' ? 404 : 500, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': contentType(file),
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, publicState());
  if (req.method === 'GET' && pathname === '/api/network') return json(res, 200, await observedNetwork());
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    for (const entry of logBuffer.slice(-100)) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/validate-address') {
    const body = await readJson(req);
    return json(res, 200, { valid: validateBitcoinAddress(body.address) });
  }
  if (req.method === 'POST' && pathname === '/api/start') {
    try {
      const body = await readJson(req);
      startMiner({
        address: String(body.address || ''),
        worker: String(body.worker || 'ricky'),
        pool: String(body.pool || ''),
        threads: Number(body.threads) || 1
      });
      return json(res, 200, { ok: true, state: publicState() });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (req.method === 'POST' && pathname === '/api/stop') {
    stopMiner('Stopped');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/api/clear-records') {
    const lifetimeHashes = state.lifetimeHashes;
    state.records = [];
    state.bestRecord = null;
    state.worstRecord = null;
    state.bestHash = null;
    state.bestShareDifficulty = 0;
    state.worstHash = null;
    state.worstDifficulty = null;
    state.currentBlock = null;
    state.lifetimeHashes = lifetimeHashes;
    shareEvidence.clear();
    scheduleSave();
    broadcastState();
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${HOST}`).pathname;
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message });
  }
});

function shutdown(signal) {
  addLog('server', `${signal} received; shutting down.`);
  stopMiner('Stopped');
  for (const client of sseClients) {
    try { client.end(); } catch (_) {}
  }
  sseClients = new Set();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/?version=reward-v8`;
    console.log('Ricky Bitcoin Reward Miner v8');
    console.log(`Open: ${url}`);
    console.log('Reward eligibility requires live authorization, a live job, and an active submission path.');
    console.log('Press Control-C to stop.');
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  server,
  validateBitcoinAddress,
  startMiner,
  stopMiner,
  publicState,
  rewardEligibility,
  rewardEligibilityForState,
  HASH_FRESHNESS_MS,
  aggregateSecond,
  currentSecondStats,
  applyHashBatch,
  ALLOWED_POOLS
};
