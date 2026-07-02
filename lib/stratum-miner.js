'use strict';

const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const MAX_TARGET = (1n << 256n) - 1n;
const DIFF1_TARGET = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');

function sha256d(buffer) {
  const first = crypto.createHash('sha256').update(buffer).digest();
  return crypto.createHash('sha256').update(first).digest();
}

function reverseHexBytes(hex) {
  return Buffer.from(hex, 'hex').reverse();
}

function swap32Words(hex) {
  const input = Buffer.from(hex, 'hex');
  if (input.length % 4 !== 0) throw new Error('Value is not made of 32-bit words');
  const output = Buffer.allocUnsafe(input.length);
  for (let offset = 0; offset < input.length; offset += 4) {
    output[offset] = input[offset + 3];
    output[offset + 1] = input[offset + 2];
    output[offset + 2] = input[offset + 1];
    output[offset + 3] = input[offset];
  }
  return output;
}

function decimalToFraction(value) {
  let text = String(value).trim().toLowerCase();
  if (!text || text.startsWith('-')) throw new Error('Difficulty must be positive');
  if (text.startsWith('+')) text = text.slice(1);

  const parts = text.split('e');
  if (parts.length > 2) throw new Error('Invalid decimal');
  const coefficient = parts[0];
  const exponent = parts[1] ? Number(parts[1]) : 0;
  if (!Number.isInteger(exponent)) throw new Error('Invalid exponent');

  const coefficientParts = coefficient.split('.');
  if (coefficientParts.length > 2) throw new Error('Invalid decimal');
  const whole = coefficientParts[0] || '0';
  const fraction = coefficientParts[1] || '';
  if (!/^\d+$/.test(whole) || (fraction && !/^\d+$/.test(fraction))) throw new Error('Invalid decimal');

  const digitsText = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  let numerator = BigInt(digitsText);
  const scale = fraction.length - exponent;
  let denominator = 1n;
  if (scale > 0) denominator = 10n ** BigInt(scale);
  else if (scale < 0) numerator *= 10n ** BigInt(-scale);
  if (numerator <= 0n) throw new Error('Difficulty must be positive');
  return { numerator, denominator };
}

function difficultyToTarget(difficulty) {
  const { numerator, denominator } = decimalToFraction(difficulty);
  const target = (DIFF1_TARGET * denominator) / numerator;
  return target > MAX_TARGET ? MAX_TARGET : target;
}

function compactToTarget(nbitsHex) {
  if (!/^[0-9a-fA-F]{8}$/.test(nbitsHex)) throw new Error('Invalid nBits');
  const compact = Number.parseInt(nbitsHex, 16) >>> 0;
  const exponent = compact >>> 24;
  const negative = Boolean(compact & 0x00800000);
  const mantissa = compact & 0x007fffff;
  if (negative) throw new Error('Negative compact target is invalid');
  if (mantissa === 0) return 0n;
  const target = exponent <= 3
    ? BigInt(mantissa) >> (8n * BigInt(3 - exponent))
    : BigInt(mantissa) << (8n * BigInt(exponent - 3));
  if (target > MAX_TARGET) throw new Error('Compact target exceeds 256 bits');
  return target;
}

function targetToDifficulty(target) {
  if (target <= 0n) return Infinity;
  const scale = 100000000n;
  const scaled = (DIFF1_TARGET * scale) / target;
  return Number(scaled) / Number(scale);
}

function ratioPercent(numerator, denominator) {
  if (denominator <= 0n) return 0;
  const scale = 1000000n;
  const scaled = (numerator * scale) / denominator;
  return Number(scaled) / 10000;
}

function isHex(value, expectedLength = null) {
  return typeof value === 'string' &&
    value.length % 2 === 0 &&
    /^[0-9a-fA-F]*$/.test(value) &&
    (expectedLength == null || value.length === expectedLength);
}

function buildWork(job, extranonce1, extranonce2) {
  if (!isHex(job.prevhash, 64) || !isHex(job.version, 8) || !isHex(job.nbits, 8) || !isHex(job.ntime, 8)) {
    throw new Error('Pool job contained invalid fixed-width hexadecimal fields');
  }
  if (![job.coinb1, job.coinb2, extranonce1, extranonce2].every(value => isHex(value))) {
    throw new Error('Pool job contained invalid coinbase or extranonce hexadecimal data');
  }

  const coinbase = Buffer.concat([
    Buffer.from(job.coinb1, 'hex'),
    Buffer.from(extranonce1, 'hex'),
    Buffer.from(extranonce2, 'hex'),
    Buffer.from(job.coinb2, 'hex')
  ]);

  let merkleRoot = sha256d(coinbase);
  for (const branchHex of job.merkleBranch) {
    if (!isHex(branchHex, 64)) throw new Error('Invalid merkle branch');
    merkleRoot = sha256d(Buffer.concat([merkleRoot, Buffer.from(branchHex, 'hex')]));
  }

  const headerPrefix = Buffer.concat([
    reverseHexBytes(job.version),
    swap32Words(job.prevhash),
    merkleRoot,
    reverseHexBytes(job.ntime),
    reverseHexBytes(job.nbits)
  ]);

  if (headerPrefix.length !== 76) throw new Error(`Header prefix was ${headerPrefix.length} bytes instead of 76`);

  return {
    headerPrefix,
    networkTarget: compactToTarget(job.nbits),
    merkleRootDisplay: merkleRoot.toString('hex')
  };
}

class StratumMiner extends EventEmitter {
  constructor(options) {
    super();
    this.pool = options.pool;
    this.username = options.username;
    this.password = options.password || 'x';
    this.threads = Math.max(1, Math.min(os.cpus().length, Number(options.threads) || 1));
    this.workerScript = options.workerScript || path.join(__dirname, 'hash-worker.js');
    this.reconnect = options.reconnect !== false;
    this.chunkSize = Math.max(16, Math.min(65536, Number(options.chunkSize) || 2048));

    this.socket = null;
    this.socketBuffer = '';
    this.workers = [];
    this.requestId = 10;
    this.pending = new Map();
    this.stopping = false;
    this.reconnectTimer = null;
    this.extranonce1 = null;
    this.extranonce2Size = null;
    this.extranonce2Counter = 0n;
    this.currentDifficulty = 1;
    this.currentJob = null;
    this.jobReceivedAt = null;
    this.generation = 0;
    this.exhaustedGeneration = null;
    this.authorized = false;
    this.subscribed = false;
    this.connected = false;
    this.lastRateAt = Date.now();
    this.hashesSinceRate = 0;
    this.hashesTotal = 0;
    this.bestValue = null;
    this.bestHash = null;
    this.worstValue = null;
    this.worstHash = null;
    this.networkTarget = null;
    this.networkDifficulty = null;
    this.shareTarget = difficultyToTarget(1);

    // Preserve the v6 event API while exposing the normalized v8 server contract.
    this._bridgePoolDifficulty = Symbol('unset');
    this.on('status', status => {
      this.emit('connection', Boolean(status.connected));
      this.emit('subscribed', Boolean(status.subscribed));
      this.emit('authorized', Boolean(status.authorized));
      this.emit('submission-ready', Boolean(status.submissionReady));
      if (status.poolDifficulty !== this._bridgePoolDifficulty) {
        this._bridgePoolDifficulty = status.poolDifficulty;
        this.emit('difficulty', status.poolDifficulty);
      }
    });
    this.on('job', job => {
      if (job && !job.networkTargetHex) job.networkTargetHex = job.networkTarget || null;
    });
    this.on('batch', batch => {
      this.emit('hash-batch', {
        ...batch,
        count: Number(batch.hashes) || 0,
        bestHash: batch.bestHashHex || null,
        worstHash: batch.worstHashHex || null,
        networkTargetHex: batch.networkTarget || null,
        shareTargetHex: batch.shareTarget || null,
        prevhash: this.currentJob?.prevhash || null,
        nbits: this.currentJob?.nbits || null,
        rewardEligible: this.submissionReady()
      });
    });
    this.on('progress', progress => this.emit('hashrate', Number(progress.hashrateHps) || 0));
    this.on('share', submission => {
      if (submission.sent) {
        this.emit('share-submitted', {
          ...submission,
          hash: submission.hashHex,
          requestId: submission.id
        });
      }
    });
    this.on('submission', result => {
      this.emit('share-result', {
        ...result,
        hash: result.hashHex,
        requestId: result.id
      });
    });
  }

  start() {
    if (this.socket || this.connected) throw new Error('Miner is already started');
    this.stopping = false;
    this.spawnWorkers();
    this.connect();
  }

  spawnWorkers() {
    if (this.workers.length) return;
    for (let index = 0; index < this.threads; index += 1) {
      const worker = new Worker(this.workerScript);
      worker.on('message', message => this.handleWorkerMessage(message));
      worker.on('error', error => this.emit('log', `Hash worker ${index + 1} error: ${error.message}`));
      worker.on('exit', code => {
        if (!this.stopping && code !== 0) this.emit('log', `Hash worker ${index + 1} exited with code ${code}`);
      });
      this.workers.push(worker);
    }
  }

  connect() {
    const parsed = new URL(this.pool);
    const host = parsed.hostname;
    const port = Number(parsed.port);
    if (parsed.protocol !== 'stratum+tcp:' || !host || !port) throw new Error('Invalid Stratum TCP pool URL');

    this.emit('log', `Connecting to ${host}:${port}…`);
    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);
    socket.setEncoding('utf8');

    socket.on('connect', () => {
      this.connected = true;
      this.socketBuffer = '';
      this.emit('log', 'TCP connection established. Subscribing to live work…');
      this.emitStatus();
      this.send({ id: 1, method: 'mining.subscribe', params: ['ricky-node-miner/8.0.0'] });
      this.send({ id: 2, method: 'mining.authorize', params: [this.username, this.password] });
    });

    socket.on('data', chunk => this.handleSocketData(chunk));
    socket.on('error', error => this.emit('log', `Pool connection error: ${error.message}`));
    socket.on('close', () => {
      this.connected = false;
      this.authorized = false;
      this.subscribed = false;
      this.currentJob = null;
      this.jobReceivedAt = null;
      this.generation += 1;
      this.stopWorkersOnly();
      this.socket = null;
      this.emit('log', 'Pool connection closed. Reward eligibility is off until a new live job is authorized.');
      this.emitStatus();
      if (!this.stopping && this.reconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
        this.reconnectTimer.unref?.();
      }
    });
  }

  send(payload) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  handleSocketData(chunk) {
    this.socketBuffer += chunk;
    if (this.socketBuffer.length > 2 * 1024 * 1024) {
      this.emit('log', 'Pool message buffer exceeded safety limit; reconnecting.');
      this.socket?.destroy();
      return;
    }
    const lines = this.socketBuffer.split('\n');
    this.socketBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleMessage(JSON.parse(trimmed));
      } catch (error) {
        this.emit('log', `Could not process pool message: ${error.message}`);
      }
    }
  }

  handleMessage(message) {
    if (message.method) {
      const params = Array.isArray(message.params) ? message.params : [];
      switch (message.method) {
        case 'mining.set_difficulty':
          this.currentDifficulty = params[0];
          this.shareTarget = difficultyToTarget(this.currentDifficulty);
          this.emit('log', `Pool share difficulty set to ${this.currentDifficulty}.`);
          if (this.authorized && this.subscribed && this.currentJob) this.dispatchJob();
          else this.emitStatus();
          break;
        case 'mining.set_extranonce':
          this.extranonce1 = String(params[0] || '');
          this.extranonce2Size = Number(params[1]);
          this.emit('log', `Pool updated extranonce (${this.extranonce2Size} byte extranonce2).`);
          if (this.currentJob) this.dispatchJob();
          break;
        case 'mining.notify':
          this.handleNotify(params);
          break;
        case 'client.show_message':
          this.emit('log', `Pool message: ${params[0] || ''}`);
          break;
        case 'client.reconnect':
          this.emit('log', 'Pool requested reconnect.');
          this.socket?.destroy();
          break;
        default:
          this.emit('log', `Pool notification: ${message.method}`);
      }
      return;
    }

    if (message.id === 1) {
      if (message.error || !Array.isArray(message.result)) {
        throw new Error(`Subscription failed: ${JSON.stringify(message.error || message.result)}`);
      }
      this.extranonce1 = String(message.result[1] || '');
      this.extranonce2Size = Number(message.result[2]);
      if (!isHex(this.extranonce1) || !Number.isInteger(this.extranonce2Size)) {
        throw new Error('Subscription returned invalid extranonce data');
      }
      this.subscribed = true;
      this.emit('log', `Subscribed. extranonce2 size: ${this.extranonce2Size} bytes.`);
      this.emitStatus();
      if (this.authorized && this.currentJob) this.dispatchJob();
      return;
    }

    if (message.id === 2) {
      this.authorized = message.result === true && !message.error;
      this.emit('log', this.authorized
        ? `Authorized as ${this.username}.`
        : `Authorization failed: ${JSON.stringify(message.error || message.result)}`);
      this.emitStatus();
      if (this.authorized && this.currentJob && this.subscribed) this.dispatchJob();
      return;
    }

    const pending = this.pending.get(message.id);
    if (pending) {
      this.pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      const accepted = message.result === true && !message.error;
      const result = { ...pending, timeout: undefined, accepted, error: message.error || null, respondedAt: Date.now() };
      this.emit('submission', result);
      this.emit('log', accepted
        ? `${pending.blockCandidate ? 'BLOCK-CANDIDATE' : 'Share'} accepted by pool.`
        : `${pending.blockCandidate ? 'BLOCK-CANDIDATE' : 'Share'} rejected: ${JSON.stringify(message.error || message.result)}`);
    }
  }

  handleNotify(params) {
    if (params.length < 9) {
      this.emit('log', 'Ignoring malformed mining.notify message.');
      return;
    }
    const [jobId, prevhash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs] = params;
    const job = {
      jobId: String(jobId),
      prevhash: String(prevhash),
      coinb1: String(coinb1),
      coinb2: String(coinb2),
      merkleBranch: Array.isArray(merkleBranch) ? merkleBranch.map(String) : [],
      version: String(version),
      nbits: String(nbits),
      ntime: String(ntime),
      cleanJobs: Boolean(cleanJobs)
    };

    // Validate the fixed job fields immediately; buildWork validates coinbase and branches before hashing.
    if (!isHex(job.prevhash, 64) || !isHex(job.version, 8) || !isHex(job.nbits, 8) || !isHex(job.ntime, 8)) {
      this.emit('log', 'Ignoring mining.notify with invalid fixed-width fields.');
      return;
    }

    this.currentJob = job;
    this.jobReceivedAt = Date.now();
    this.emit('job', {
      ...job,
      receivedAt: this.jobReceivedAt,
      networkTarget: `0x${compactToTarget(job.nbits).toString(16).padStart(64, '0')}`,
      networkDifficulty: targetToDifficulty(compactToTarget(job.nbits))
    });
    this.emit('log', `Received live job ${job.jobId}${job.cleanJobs ? ' (new block work)' : ''}.`);
    if (this.authorized && this.subscribed && this.extranonce1 !== null) this.dispatchJob();
    else this.emitStatus();
  }

  nextExtranonce2() {
    const bytes = this.extranonce2Size;
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 16) throw new Error('Invalid extranonce2 size');
    const modulo = 1n << BigInt(bytes * 8);
    const value = this.extranonce2Counter % modulo;
    this.extranonce2Counter = (this.extranonce2Counter + 1n) % modulo;
    return value.toString(16).padStart(bytes * 2, '0');
  }

  dispatchJob() {
    try {
      if (!this.currentJob || this.extranonce1 === null || this.extranonce2Size === null) return;
      const extranonce2 = this.nextExtranonce2();
      const built = buildWork(this.currentJob, this.extranonce1, extranonce2);
      this.generation += 1;
      this.exhaustedGeneration = null;
      this.networkTarget = built.networkTarget;
      this.networkDifficulty = targetToDifficulty(built.networkTarget);
      const work = {
        generation: this.generation,
        headerPrefixHex: built.headerPrefix.toString('hex'),
        shareTargetHex: this.shareTarget.toString(16).padStart(64, '0'),
        networkTargetHex: built.networkTarget.toString(16).padStart(64, '0'),
        jobId: this.currentJob.jobId,
        extranonce2,
        ntime: this.currentJob.ntime,
        version: this.currentJob.version,
        stride: this.workers.length,
        chunkSize: this.chunkSize
      };

      this.workers.forEach((worker, index) => {
        worker.postMessage({ type: 'start', work: { ...work, workerId: index, nextNonce: index } });
      });
      this.emit('work', {
        generation: this.generation,
        jobId: this.currentJob.jobId,
        extranonce2,
        ntime: this.currentJob.ntime,
        version: this.currentJob.version,
        shareTarget: `0x${this.shareTarget.toString(16).padStart(64, '0')}`,
        networkTarget: `0x${built.networkTarget.toString(16).padStart(64, '0')}`,
        networkDifficulty: this.networkDifficulty,
        poolDifficulty: this.currentDifficulty,
        merkleRoot: built.merkleRootDisplay
      });
      this.emit('log', `Hashing live job ${this.currentJob.jobId} with ${this.workers.length} thread(s), generation ${this.generation}.`);
      this.emitStatus();
    } catch (error) {
      this.emit('log', `Could not build live job: ${error.message}`);
      this.emitStatus();
    }
  }

  handleWorkerMessage(message) {
    if (message.generation !== this.generation) return;

    if (message.type === 'batch') {
      this.hashesSinceRate += Number(message.hashes || 0);
      this.hashesTotal += Number(message.hashes || 0);

      if (message.bestValueHex) {
        const value = BigInt(`0x${message.bestValueHex}`);
        if (this.bestValue === null || value < this.bestValue) {
          this.bestValue = value;
          this.bestHash = message.bestHashHex;
        }
      }
      if (message.worstValueHex) {
        const value = BigInt(`0x${message.worstValueHex}`);
        if (this.worstValue === null || value > this.worstValue) {
          this.worstValue = value;
          this.worstHash = message.worstHashHex;
        }
      }

      this.emit('batch', {
        ...message,
        poolDifficulty: this.currentDifficulty,
        networkDifficulty: this.networkDifficulty,
        networkTarget: this.networkTarget ? `0x${this.networkTarget.toString(16).padStart(64, '0')}` : null,
        shareTarget: `0x${this.shareTarget.toString(16).padStart(64, '0')}`,
        hashesTotal: this.hashesTotal
      });

      const now = Date.now();
      const elapsed = (now - this.lastRateAt) / 1000;
      if (elapsed >= 1) {
        const hashrateHps = this.hashesSinceRate / elapsed;
        this.hashesSinceRate = 0;
        this.lastRateAt = now;
        this.emit('progress', {
          hashrateHps,
          hashesTotal: this.hashesTotal,
          bestHash: this.bestHash,
          bestDifficulty: this.bestValue ? targetToDifficulty(this.bestValue) : 0,
          worstHash: this.worstHash,
          worstDifficulty: this.worstValue ? targetToDifficulty(this.worstValue) : null,
          closestPercent: this.bestValue && this.networkTarget ? ratioPercent(this.networkTarget, this.bestValue) : 0,
          networkDifficulty: this.networkDifficulty,
          networkTarget: this.networkTarget ? `0x${this.networkTarget.toString(16).padStart(64, '0')}` : null,
          poolDifficulty: this.currentDifficulty
        });
      }
      return;
    }

    if (message.type === 'share') {
      const id = this.requestId++;
      const submission = {
        id,
        generation: message.generation,
        workerId: message.workerId,
        jobId: message.jobId,
        extranonce2: message.extranonce2,
        ntime: message.ntime,
        nonce: message.nonce,
        nonceHex: message.nonceHex,
        hashHex: message.hashHex,
        hashValueHex: message.hashValueHex,
        difficulty: message.difficulty,
        blockCandidate: Boolean(message.blockCandidate),
        foundAt: message.foundAt,
        submittedAt: Date.now()
      };
      const sent = this.send({
        id,
        method: 'mining.submit',
        params: [this.username, submission.jobId, submission.extranonce2, submission.ntime, submission.nonceHex]
      });
      this.emit('share', { ...submission, sent });

      if (!sent) {
        this.emit('submission', { ...submission, accepted: false, error: 'socket-not-writable', respondedAt: Date.now() });
        this.emit('log', 'Qualifying hash found, but the submission socket was not writable.');
        return;
      }

      submission.timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.emit('submission', { ...submission, timeout: undefined, accepted: false, error: 'pool-response-timeout', respondedAt: Date.now() });
        this.emit('log', 'Pool did not respond to a submitted share within 60 seconds.');
      }, 60000);
      submission.timeout.unref?.();
      this.pending.set(id, submission);

      if (submission.blockCandidate) {
        this.emit('log', `Potential winning block hash found: ${submission.hashHex}. Submitted immediately.`);
      }
      return;
    }

    if (message.type === 'exhausted' && this.exhaustedGeneration !== this.generation) {
      this.exhaustedGeneration = this.generation;
      this.emit('log', `Nonce space exhausted for generation ${this.generation}; rotating extranonce2 to avoid duplicate work.`);
      this.dispatchJob();
    }
  }

  stopWorkersOnly() {
    for (const worker of this.workers) worker.postMessage({ type: 'stop' });
  }

  submissionReady() {
    return Boolean(
      this.connected &&
      this.subscribed &&
      this.authorized &&
      this.currentJob &&
      this.networkTarget &&
      this.socket &&
      !this.socket.destroyed &&
      this.socket.writable &&
      this.workers.length
    );
  }

  emitStatus() {
    this.emit('status', {
      connected: this.connected,
      subscribed: this.subscribed,
      authorized: this.authorized,
      jobId: this.currentJob?.jobId || null,
      jobReceivedAt: this.jobReceivedAt,
      generation: this.generation || null,
      poolDifficulty: this.currentDifficulty,
      networkDifficulty: this.networkDifficulty,
      networkTarget: this.networkTarget ? `0x${this.networkTarget.toString(16).padStart(64, '0')}` : null,
      submissionReady: this.submissionReady()
    });
  }

  async stop() {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.generation += 1;
    this.stopWorkersOnly();
    const terminations = this.workers.map(worker => worker.terminate().catch(() => undefined));
    this.workers = [];
    await Promise.all(terminations);
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.authorized = false;
    this.subscribed = false;
    this.currentJob = null;
    this.jobReceivedAt = null;
    this.emitStatus();
  }
}

module.exports = {
  StratumMiner,
  sha256d,
  difficultyToTarget,
  compactToTarget,
  targetToDifficulty,
  buildWork,
  DIFF1_TARGET,
  MAX_TARGET
};
