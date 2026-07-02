'use strict';

const assert = require('assert');
const Records = require('../record-utils.js');

const first = Records.createRecord({
  at: 1_700_000_000_000,
  hash: '0000abcd',
  difficulty: 10,
  networkDifficulty: 1000,
  networkHeight: 900000,
  networkTipHash: 'tip-a',
  sessionHashes: 25,
  lifetimeHashes: 125,
  currentBlockHashes: 15,
  sessionId: 'session-a',
  jobId: 'local-job-a',
  workerId: 1,
  nonce: 42,
  hashrate: 1000000,
  runtimeMs: 5000
});

assert.strictEqual(first.timestamp, '2023-11-14T22:13:20.000Z');
assert.strictEqual(first.targetPercentage, 1);
assert.strictEqual(first.improvementMultiplier, null);
assert.strictEqual(first.submitted, false);
assert.strictEqual(first.shareAccepted, false);
assert.strictEqual(first.blockCandidate, false);
assert.strictEqual(first.blockCandidateStatus, 'ineligible-synthetic-work');
assert.strictEqual(first.meetsNetworkDifficulty, false);

const second = Records.createRecord({
  at: 1_700_000_001_000,
  hash: '000000ff',
  difficulty: 50,
  previousHash: first.hash,
  previousDifficulty: first.difficulty,
  previousAt: first.at,
  networkDifficulty: 1000
});

assert.strictEqual(second.improvementMultiplier, 5);
assert.strictEqual(second.targetPercentage, 5);
assert.strictEqual(second.previousHash, first.hash);

const legacy = Records.normalizeRecords([
  { at: 1000, hash: 'ff', difficulty: 1, totalHashes: 7 },
  { at: 2000, hash: '0f', difficulty: 4, totalHashes: 11 }
]);

assert.strictEqual(legacy.length, 2);
assert.strictEqual(legacy[0].sessionHashes, 7);
assert.strictEqual(legacy[1].previousHash, 'ff');
assert.strictEqual(legacy[1].improvementMultiplier, 4);
assert.strictEqual(legacy[1].submissionStatus, 'not-submitted');

const original = Records.createBlockScope({ height: 100, tipHash: 'tip-100' }, 5000);
original.hashes = 123;
const same = Records.reconcileBlockScope(original, { height: 100, tipHash: 'tip-100' }, 6000);
assert.strictEqual(same.reset, false);
assert.strictEqual(same.scope.hashes, 123);

const changed = Records.reconcileBlockScope(original, { height: 101, tipHash: 'tip-101' }, 7000);
assert.strictEqual(changed.reset, true);
assert.strictEqual(changed.scope.height, 101);
assert.strictEqual(changed.scope.tipHash, 'tip-101');
assert.strictEqual(changed.scope.hashes, 0);
assert.strictEqual(changed.scope.startedAt, 7000);

console.log('Record metadata and reset-scope tests passed.');
