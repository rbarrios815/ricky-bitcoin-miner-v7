'use strict';

const assert = require('assert');
const net = require('net');
const { StratumMiner } = require('../lib/stratum-miner');

function waitFor(emitter, event, predicate = () => true, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = value => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(event, handler);
      resolve(value);
    };
    emitter.on(event, handler);
  });
}

async function main() {
  let receivedSubmit = null;
  const mock = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method === 'mining.subscribe') {
          socket.write(`${JSON.stringify({ id: message.id, result: [[['mining.notify', 'bridge-sub']], '01020304', 4], error: null })}\n`);
        } else if (message.method === 'mining.authorize') {
          socket.write(`${JSON.stringify({ id: message.id, result: true, error: null })}\n`);
          socket.write(`${JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [1e-20] })}\n`);
          socket.write(`${JSON.stringify({
            id: null,
            method: 'mining.notify',
            params: [
              'bridge-job',
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
    username: 'bc1qjuf2d7s5mfukj50pd48ruk6asxqy7c4rtgx0sx.bridge',
    threads: 1,
    reconnect: false,
    chunkSize: 16
  });
  miner.lastRateAt = Date.now() - 1100;

  const connected = waitFor(miner, 'connection', value => value === true);
  const subscribed = waitFor(miner, 'subscribed', value => value === true);
  const authorized = waitFor(miner, 'authorized', value => value === true);
  const difficulty = waitFor(miner, 'difficulty', value => value === 1e-20);
  const job = waitFor(miner, 'job', value => value.jobId === 'bridge-job' && Boolean(value.networkTargetHex));
  const work = waitFor(miner, 'work', value => value.jobId === 'bridge-job' && Number.isInteger(value.generation));
  const ready = waitFor(miner, 'submission-ready', value => value === true);
  const batch = waitFor(miner, 'hash-batch', value => value.jobId === 'bridge-job');
  const hashrate = waitFor(miner, 'hashrate', value => Number(value) > 0);
  const submitted = waitFor(miner, 'share-submitted', value => value.jobId === 'bridge-job');
  const result = waitFor(miner, 'share-result', value => value.jobId === 'bridge-job' && value.accepted === true);

  miner.start();
  const values = await Promise.all([connected, subscribed, authorized, difficulty, job, work, ready, batch, hashrate, submitted, result]);
  const bridgeWork = values[5];
  const bridgeBatch = values[7];
  const bridgeSubmission = values[9];
  const bridgeResult = values[10];

  assert.strictEqual(bridgeWork.generation, bridgeBatch.generation);
  assert.strictEqual(bridgeWork.jobId, bridgeBatch.jobId);
  assert.strictEqual(bridgeBatch.count, 16);
  assert.strictEqual(typeof bridgeBatch.bestHash, 'string');
  assert.strictEqual(typeof bridgeBatch.worstHash, 'string');
  assert.strictEqual(bridgeBatch.networkTargetHex.startsWith('0x'), true);
  assert.strictEqual(bridgeBatch.shareTargetHex.startsWith('0x'), true);
  assert.strictEqual(bridgeBatch.rewardEligible, true);
  assert.strictEqual(bridgeSubmission.requestId, bridgeSubmission.id);
  assert.strictEqual(bridgeSubmission.hash, bridgeSubmission.hashHex);
  assert.strictEqual(bridgeResult.requestId, bridgeResult.id);
  assert.strictEqual(bridgeResult.hash, bridgeResult.hashHex);
  assert.ok(receivedSubmit);

  await miner.stop();
  await new Promise(resolve => mock.close(resolve));
  console.log('Event bridge test passed: v6 legacy events and v8 normalized lifecycle, telemetry, and submission events are live.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
