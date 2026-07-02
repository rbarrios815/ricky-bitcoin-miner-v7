'use strict';

const assert = require('assert');
const net = require('net');
const crypto = require('crypto');
const { validateBitcoinAddress, processBatch, currentSecondStats } = require('./server');
const {
  StratumMiner,
  sha256d,
  difficultyToTarget,
  compactToTarget,
  buildWork,
  MAX_TARGET
} = require('./lib/stratum-miner');

const WORKED_JOB = {
  jobId: '5c04',
  prevhash: 'da0dadb0eda4381df442bde08d23d54d7d371d5ce7af3ee716bd2a7e017eacb8',
  coinb1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2a03700a08062f503253482f04953f1a5308',
  coinb2: '102f776166666c65706f6f6c2e636f6d2f0000000001d07e582a010000001976a9145d8f33b0a7c94c878d572c40cbff22a49268467d88ac00000000',
  merkleBranch: [
    '50a4a386ab344d40d29a833b6e40ea27dab6e5a79a2f8648d3bc0d1aa65ecd3f',
    '7952ecc836fb104f41b2cb06608eeeaa6d1ca2fe4391708fb13bb10ccf8da179',
    '9400ec6453aac577fb6807f11219b4243a3e50ca6d1c727e6d05663211960c94',
    'c11a630fa9332ab51d886a47509b5cbace844316f4fc52b493359b305fd489ae',
    '85891e7c5773f234d647f1d5fca7fbcabb59b261322d16c0ae486ccf5143383d',
    'faa26bbc17f99659f64136bea29b3fc8d772b339c52707d5f2ccfe1195317f43'
  ],
  version: '00000002',
  nbits: '1b10b60e',
  ntime: '531a3f95'
};

function withTimeout(promise, message, milliseconds = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

async function testMockStratum() {
  let receivedSubmit = null;
  let subscriptionSeen = false;
  let authorizationSeen = false;

  const mock = net.createServer(socket => {
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method === 'mining.subscribe') {
          subscriptionSeen = true;
          socket.write(`${JSON.stringify({ id: message.id, result: [[['mining.notify', 'sub-id']], '01020304', 4], error: null })}\n`);
        } else if (message.method === 'mining.authorize') {
          authorizationSeen = true;
          socket.write(`${JSON.stringify({ id: message.id, result: true, error: null })}\n`);
          socket.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [1e-20] })}\n`);
          socket.write(`${JSON.stringify({
            id: null,
            method: 'mining.notify',
            params: [
              'mock-job',
              '0000000000000000000000000000000000000000000000000000000000000000',
              '00',
              '00',
              [],
              '20000000',
              '207fffff',
              Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
              true
            ]
          })}\n`);
        } else if (message.method === 'mining.submit') {
          receivedSubmit = message;
          socket.write(`${JSON.stringify({ id: message.id, result: true, error: null })}\n`);
        }
      }
    });
  });

  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const { port } = mock.address();
  const miner = new StratumMiner({
    pool: `stratum+tcp://127.0.0.1:${port}`,
    username: 'bc1qjuf2d7s5mfukj50pd48ruk6asxqy7c4rtgx0sx.test',
    threads: 1,
    reconnect: false,
    chunkSize: 16
  });

  let readyStatus = null;
  const ready = new Promise(resolve => miner.on('status', status => {
    if (status.submissionReady) { readyStatus = status; resolve(status); }
  }));
  const job = new Promise(resolve => miner.once('job', resolve));
  const batch = new Promise(resolve => miner.once('batch', resolve));
  const accepted = new Promise(resolve => miner.on('submission', result => {
    if (result.accepted) resolve(result);
  }));

  miner.start();
  const [jobResult, batchResult, acceptedResult] = await withTimeout(
    Promise.all([job, batch, accepted, ready]),
    'Mock Stratum subscribe → authorize → live job → batch → submit cycle timed out'
  );

  assert.strictEqual(subscriptionSeen, true);
  assert.strictEqual(authorizationSeen, true);
  assert.strictEqual(jobResult.jobId, 'mock-job');
  assert.strictEqual(readyStatus.submissionReady, true);
  assert.strictEqual(batchResult.jobId, 'mock-job');
  assert.strictEqual(batchResult.hashes, 16);
  assert.ok(batchResult.prefixes instanceof ArrayBuffer);
  assert.ok(Array.isArray(batchResult.recordCandidates));
  assert.ok(batchResult.recordCandidates.length >= 1);
  assert.strictEqual(acceptedResult.accepted, true);
  assert.ok(receivedSubmit);
  assert.strictEqual(receivedSubmit.params[0], 'bc1qjuf2d7s5mfukj50pd48ruk6asxqy7c4rtgx0sx.test');
  assert.strictEqual(receivedSubmit.params[1], 'mock-job');
  assert.strictEqual(receivedSubmit.params[2].length, 8);
  assert.strictEqual(receivedSubmit.params[3].length, 8);
  assert.strictEqual(receivedSubmit.params[4].length, 8);
  assert.strictEqual(
    `0x${miner.networkTarget.toString(16).padStart(64, '0')}`,
    `0x${compactToTarget('207fffff').toString(16).padStart(64, '0')}`
  );

  await miner.stop();
  await new Promise(resolve => mock.close(resolve));
}

async function main() {
  assert.strictEqual(validateBitcoinAddress('bc1qjuf2d7s5mfukj50pd48ruk6asxqy7c4rtgx0sx'), true);
  assert.strictEqual(validateBitcoinAddress('bc1qjuf2d7s5mfukj50pd48ruk6asxqy7c4rtgx0sy'), false);
  assert.strictEqual(validateBitcoinAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), true);
  assert.strictEqual(validateBitcoinAddress('not-an-address'), false);

  const hello = sha256d(Buffer.from('hello')).toString('hex');
  const expectedHello = crypto.createHash('sha256').update(crypto.createHash('sha256').update('hello').digest()).digest('hex');
  assert.strictEqual(hello, expectedHello);

  assert.strictEqual(difficultyToTarget(1).toString(16).padStart(64, '0'), '00000000ffff0000000000000000000000000000000000000000000000000000');
  assert.strictEqual(difficultyToTarget(1e-20), MAX_TARGET);
  assert.strictEqual(compactToTarget('1d00ffff').toString(16).padStart(64, '0'), '00000000ffff0000000000000000000000000000000000000000000000000000');
  assert.throws(() => compactToTarget('1d80ffff'), /Negative compact target/);

  const genesisHeader = Buffer.from(
    '01000000' +
    '00'.repeat(32) +
    '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' +
    '29ab5f49' +
    'ffff001d' +
    '1dac2b7c',
    'hex'
  );
  assert.strictEqual(
    Buffer.from(sha256d(genesisHeader)).reverse().toString('hex'),
    '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
  );

  const built = buildWork(WORKED_JOB, '60021014', '00000000');
  assert.strictEqual(built.merkleRootDisplay, '43c4345eb9ad9135836f5c31b697f62429c1be08d55906ff407852adfba680a5');
  assert.strictEqual(
    built.headerPrefix.toString('hex'),
    '02000000b0ad0dda1d38a4ede0bd42f44dd5238d5c1d377de73eafe77e2abd16b8ac7e0143c4345eb9ad9135836f5c31b697f62429c1be08d55906ff407852adfba680a5953f1a530eb6101b'
  );

  const prefixes = new Float64Array([1, 2, 3, 4]);
  processBatch({
    generation: 1,
    workerId: 0,
    jobId: 'telemetry-job',
    extranonce2: '00000000',
    ntime: '00000000',
    version: '20000000',
    second: Math.floor(Date.now() / 1000),
    hashes: 4,
    bestHashHex: '00'.repeat(32),
    bestDifficulty: 100,
    bestNonce: 1,
    bestOffset: 0,
    bestFoundAt: Date.now(),
    worstHashHex: 'ff'.repeat(32),
    worstDifficulty: 0.00000001,
    worstNonce: 4,
    worstOffset: 3,
    worstFoundAt: Date.now(),
    recordCandidates: [{ hash: '00'.repeat(32), difficulty: 100, nonce: 1, offset: 0, foundAt: Date.now() }],
    prefixes: prefixes.buffer,
    poolDifficulty: 1,
    networkDifficulty: 1000,
    networkTarget: `0x${'0f'.repeat(32)}`,
    shareTarget: `0x${'ff'.repeat(32)}`
  });
  const second = currentSecondStats();
  assert.strictEqual(second.count, 4);
  assert.strictEqual(second.best.hash, '00'.repeat(32));
  assert.strictEqual(second.worst.hash, 'ff'.repeat(32));
  assert.strictEqual(second.median.percentile > 0, true);

  const html = require('fs').readFileSync(require('path').join(__dirname, 'public', 'index.html'), 'utf8');
  assert.ok(html.includes('Start reward-eligible attempt'));
  const appSource = require('fs').readFileSync(require('path').join(__dirname, 'public', 'app.js'), 'utf8');
  assert.ok(appSource.includes('REWARD-ELIGIBLE WORK ACTIVE'));
  assert.ok(html.includes('Best hash · current second'));
  assert.ok(!html.includes('browser SHA-256d demo'));

  await testMockStratum();
  console.log('All tests passed: vectors, targets, address checks, live-job construction, per-second telemetry, eligibility readiness, and mock Stratum submission.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
