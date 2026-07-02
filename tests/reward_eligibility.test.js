'use strict';

const assert = require('assert');
const { rewardEligibilityForState, HASH_FRESHNESS_MS } = require('../server');

const now = 1_800_000_000_000;
const ready = {
  running: true,
  connected: true,
  subscribed: true,
  authorized: true,
  jobId: 'job-current',
  generation: 7,
  networkTarget: `0x${'0f'.repeat(32)}`,
  currentWork: { jobId: 'job-current', generation: 7 },
  submissionReady: true,
  lastHashBatchAt: null,
  lastHashJobId: null,
  lastHashGeneration: null,
  lastHashCount: 0
};

assert.deepStrictEqual(
  rewardEligibilityForState(ready, now),
  { eligible: false, reason: 'Waiting for fresh hashing evidence' }
);

assert.strictEqual(rewardEligibilityForState({
  ...ready,
  lastHashBatchAt: now - 100,
  lastHashJobId: 'old-job',
  lastHashGeneration: 7,
  lastHashCount: 16
}, now).eligible, false);

assert.strictEqual(rewardEligibilityForState({
  ...ready,
  lastHashBatchAt: now - 100,
  lastHashJobId: 'job-current',
  lastHashGeneration: 6,
  lastHashCount: 16
}, now).eligible, false);

assert.strictEqual(rewardEligibilityForState({
  ...ready,
  lastHashBatchAt: now - HASH_FRESHNESS_MS - 1,
  lastHashJobId: 'job-current',
  lastHashGeneration: 7,
  lastHashCount: 16
}, now).eligible, false);

assert.deepStrictEqual(rewardEligibilityForState({
  ...ready,
  lastHashBatchAt: now - 100,
  lastHashJobId: 'job-current',
  lastHashGeneration: 7,
  lastHashCount: 16
}, now), {
  eligible: true,
  reason: 'Authorized live Stratum work with fresh hashing and an active submission path'
});

console.log('Reward eligibility tests passed: fresh positive-count hashing must match the current job and generation.');
