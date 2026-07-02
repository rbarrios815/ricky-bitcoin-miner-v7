'use strict';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'rickyMinerV7State';
const RecordUtils = globalThis.RickyMinerRecords;

if (!RecordUtils) throw new Error('record-utils.js must load before app.js');

const state = {
  running: false,
  paused: false,
  workers: [],
  sessionHashes: 0,
  lifetimeHashes: 0,
  sessionId: makeSessionId(),
  startedAt: null,
  elapsedBeforeStart: 0,
  rateWindow: [],
  buckets: new Map(),
  best: null,
  worst: null,
  records: [],
  chartPoints: [],
  networkDifficulty: null,
  networkHashrate: null,
  networkHeight: null,
  networkTipHash: null,
  networkFetchedAt: null,
  currentBlock: null
};

let saveTimer = null;

function makeSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function compareHash(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function normalizeSavedExtremum(value) {
  if (!value || !value.hash) return null;
  return {
    ...value,
    sessionHashes: value.sessionHashes ?? value.totalHashes ?? null,
    lifetimeHashes: value.lifetimeHashes ?? null
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.records = RecordUtils.normalizeRecords(saved.records).slice(-500);
    state.best = state.records[state.records.length - 1] || normalizeSavedExtremum(saved.best) || null;
    state.worst = normalizeSavedExtremum(saved.worst);
    state.chartPoints = Array.isArray(saved.chartPoints)
      ? saved.chartPoints.slice(-1000)
      : state.records.map((record) => ({ at: record.at, difficulty: record.difficulty })).slice(-1000);
    state.currentBlock = saved.currentBlock || null;

    const recordLifetime = state.records.reduce(
      (max, record) => Math.max(max, Number(record.lifetimeHashes) || 0),
      0
    );
    const legacySessionMaximum = state.records.reduce(
      (max, record) => Math.max(max, Number(record.sessionHashes) || 0),
      0
    );
    state.lifetimeHashes = Math.max(
      Number(saved.lifetimeHashes) || 0,
      recordLifetime,
      legacySessionMaximum
    );
  } catch (error) {
    console.warn('Could not load saved miner state:', error);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: RecordUtils.SCHEMA_VERSION,
    lifetimeHashes: state.lifetimeHashes,
    best: state.best,
    worst: state.worst,
    records: state.records.slice(-500),
    chartPoints: state.chartPoints.slice(-1000),
    currentBlock: state.currentBlock
  }));
}

function scheduleSave() {
  if (saveTimer != null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 1000);
}

function formatNumber(number, digits = 3) {
  if (number == null || Number.isNaN(Number(number))) return '—';
  const value = Number(number);
  if (!Number.isFinite(value)) return '∞';
  const absolute = Math.abs(value);
  if (absolute === 0) return '0';
  if (absolute >= 1e12 || absolute < 1e-6) return value.toExponential(digits);
  if (absolute >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toLocaleString(undefined, { maximumSignificantDigits: digits + 2 });
}


function formatCount(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Math.trunc(Number(value)).toLocaleString();
}

function formatStoredHashrate(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return formatHashrate(Number(value));
}

function formatHashrate(hashrate) {
  let value = Number(hashrate) || 0;
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours, minutes, remaining].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatFriendlyDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return '<1 sec';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTargetPercentage(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  if (number === 0) return '0%';
  if (number < 0.000001) return `${number.toExponential(5)}%`;
  return `${number.toFixed(number < 0.01 ? 6 : 3)}%`;
}

function shortHash(hash, length = 12) {
  if (!hash) return '—';
  const text = String(hash);
  return text.length <= length * 2 ? text : `${text.slice(0, length)}…${text.slice(-length)}`;
}

function ensureBucket(second) {
  if (!state.buckets.has(second)) {
    state.buckets.set(second, {
      second,
      count: 0,
      best: null,
      worst: null,
      segments: [],
      median: null,
      dirty: true
    });
  }
  return state.buckets.get(second);
}

function ensureCurrentBlock() {
  if (!state.currentBlock) {
    state.currentBlock = RecordUtils.createBlockScope({
      height: state.networkHeight,
      tipHash: state.networkTipHash
    });
  }
  return state.currentBlock;
}

function updateCurrentBlockExtrema(message) {
  const block = ensureCurrentBlock();
  if (!block.best || compareHash(message.bestHash, block.best.hash) < 0) {
    block.best = {
      hash: message.bestHash,
      difficulty: message.bestDifficulty,
      at: message.bestFoundAt || Date.now()
    };
  }
  if (!block.worst || compareHash(message.worstHash, block.worst.hash) > 0) {
    block.worst = {
      hash: message.worstHash,
      difficulty: message.worstDifficulty,
      at: message.worstFoundAt || Date.now()
    };
  }
}

function aggregateBatch(message) {
  const bucket = ensureBucket(message.second);
  bucket.count += message.count;
  bucket.segments.push(new Float64Array(message.prefixes));
  bucket.dirty = true;

  if (!bucket.best || compareHash(message.bestHash, bucket.best.hash) < 0) {
    bucket.best = { hash: message.bestHash, difficulty: message.bestDifficulty };
  }
  if (!bucket.worst || compareHash(message.worstHash, bucket.worst.hash) > 0) {
    bucket.worst = { hash: message.worstHash, difficulty: message.worstDifficulty };
  }

  const sessionBefore = state.sessionHashes;
  const lifetimeBefore = state.lifetimeHashes;
  const block = ensureCurrentBlock();
  const blockBefore = Number(block.hashes) || 0;

  const nowPerformance = performance.now();
  state.rateWindow.push({ t: nowPerformance, count: message.count });
  while (state.rateWindow.length && nowPerformance - state.rateWindow[0].t > 3000) {
    state.rateWindow.shift();
  }

  const candidates = Array.isArray(message.recordCandidates)
    ? [...message.recordCandidates].sort((a, b) => (a.offset - b.offset))
    : [{
        hash: message.bestHash,
        difficulty: message.bestDifficulty,
        offset: Math.max(0, message.bestOffset ?? message.count - 1),
        foundAt: message.bestFoundAt || Date.now(),
        nonce: message.bestNonce ?? null
      }];

  for (const candidate of candidates) {
    considerBestCandidate(candidate, message, {
      sessionHashes: sessionBefore + Number(candidate.offset || 0) + 1,
      lifetimeHashes: lifetimeBefore + Number(candidate.offset || 0) + 1,
      currentBlockHashes: blockBefore + Number(candidate.offset || 0) + 1,
      hashrate: currentRate(),
      runtimeMs: activeElapsed()
    });
  }

  considerWorst(message, {
    sessionHashes: sessionBefore + Number(message.worstOffset ?? message.count - 1) + 1,
    lifetimeHashes: lifetimeBefore + Number(message.worstOffset ?? message.count - 1) + 1,
    currentBlockHashes: blockBefore + Number(message.worstOffset ?? message.count - 1) + 1
  });

  updateCurrentBlockExtrema(message);
  state.sessionHashes += message.count;
  state.lifetimeHashes += message.count;
  block.hashes = blockBefore + message.count;

  const cutoff = Math.floor(Date.now() / 1000) - 3;
  for (const second of state.buckets.keys()) {
    if (second < cutoff) state.buckets.delete(second);
  }

  scheduleSave();
}

function considerBestCandidate(candidate, message, counts) {
  if (state.best && compareHash(candidate.hash, state.best.hash) >= 0) return;

  const previous = state.best;
  const record = RecordUtils.createRecord({
    at: candidate.foundAt || Date.now(),
    hash: candidate.hash,
    difficulty: candidate.difficulty,
    previousHash: previous?.hash ?? null,
    previousDifficulty: previous?.difficulty ?? null,
    previousAt: previous?.at ?? null,
    networkDifficulty: state.networkDifficulty,
    networkHeight: state.networkHeight,
    networkTipHash: state.networkTipHash,
    networkFetchedAt: state.networkFetchedAt,
    sessionHashes: counts.sessionHashes,
    lifetimeHashes: counts.lifetimeHashes,
    currentBlockHashes: counts.currentBlockHashes,
    sessionId: state.sessionId,
    jobId: message.jobId,
    blockTemplateId: null,
    workSource: 'synthetic-local',
    workerId: message.workerId,
    nonce: candidate.nonce,
    submitted: false,
    submissionStatus: 'not-submitted-local-only',
    shareAccepted: false,
    blockCandidate: false,
    blockCandidateStatus: 'ineligible-synthetic-work',
    hashrate: counts.hashrate,
    runtimeMs: counts.runtimeMs
  });

  state.best = record;
  state.records.push(record);
  state.records = state.records.slice(-500);
  state.chartPoints.push({ at: record.at, difficulty: record.difficulty });
  state.chartPoints = state.chartPoints.slice(-1000);
  saveState();
  renderRecords();
  drawChart();
}

function considerWorst(message, counts) {
  if (state.worst && compareHash(message.worstHash, state.worst.hash) <= 0) return;
  state.worst = {
    hash: message.worstHash,
    difficulty: message.worstDifficulty,
    at: message.worstFoundAt || Date.now(),
    sessionHashes: counts.sessionHashes,
    lifetimeHashes: counts.lifetimeHashes,
    currentBlockHashes: counts.currentBlockHashes,
    jobId: message.jobId,
    workerId: message.workerId,
    nonce: message.worstNonce ?? null
  };
  saveState();
}

