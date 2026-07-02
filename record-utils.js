'use strict';

(function initRecordUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RickyMinerRecords = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function recordUtilsFactory() {
  const SCHEMA_VERSION = 2;

  function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function integerOrNull(value) {
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
  }

  function targetPercentage(difficulty, networkDifficulty) {
    const diff = finiteOrNull(difficulty);
    const network = finiteOrNull(networkDifficulty);
    if (diff == null || network == null || network <= 0) return null;
    return (diff / network) * 100;
  }

  function improvementMultiplier(difficulty, previousDifficulty) {
    const diff = finiteOrNull(difficulty);
    const previous = finiteOrNull(previousDifficulty);
    if (diff == null || previous == null || previous <= 0) return null;
    return diff / previous;
  }

  function recordId(at, hash) {
    return `${Number(at) || Date.now()}-${String(hash || '').slice(0, 16)}`;
  }

  function createRecord(input) {
    const at = Number(input.at) || Date.now();
    const difficulty = finiteOrNull(input.difficulty);
    const previousDifficulty = finiteOrNull(input.previousDifficulty);
    const networkDifficulty = finiteOrNull(input.networkDifficulty);
    const meetsNetworkDifficulty = Boolean(
      difficulty != null &&
      networkDifficulty != null &&
      networkDifficulty > 0 &&
      difficulty >= networkDifficulty
    );

    return {
      schemaVersion: SCHEMA_VERSION,
      id: input.id || recordId(at, input.hash),
      at,
      timestamp: new Date(at).toISOString(),
      hash: String(input.hash || ''),
      difficulty,
      previousHash: input.previousHash ? String(input.previousHash) : null,
      previousDifficulty,
      previousAt: finiteOrNull(input.previousAt),
      improvementMultiplier: improvementMultiplier(difficulty, previousDifficulty),
      networkDifficulty,
      networkHeight: integerOrNull(input.networkHeight),
      networkTipHash: input.networkTipHash ? String(input.networkTipHash) : null,
      networkFetchedAt: finiteOrNull(input.networkFetchedAt),
      targetPercentage: targetPercentage(difficulty, networkDifficulty),
      sessionHashes: finiteOrNull(input.sessionHashes),
      lifetimeHashes: finiteOrNull(input.lifetimeHashes),
      currentBlockHashes: finiteOrNull(input.currentBlockHashes),
      sessionId: input.sessionId ? String(input.sessionId) : null,
      jobId: input.jobId ? String(input.jobId) : null,
      blockTemplateId: input.blockTemplateId ? String(input.blockTemplateId) : null,
      workSource: input.workSource || 'synthetic-local',
      workerId: integerOrNull(input.workerId),
      nonce: integerOrNull(input.nonce),
      submitted: Boolean(input.submitted),
      submissionStatus: input.submissionStatus || 'not-submitted',
      shareAccepted: Boolean(input.shareAccepted),
      blockCandidate: Boolean(input.blockCandidate),
      blockCandidateStatus: input.blockCandidateStatus || 'ineligible-synthetic-work',
      meetsNetworkDifficulty,
      hashrate: finiteOrNull(input.hashrate),
      runtimeMs: finiteOrNull(input.runtimeMs)
    };
  }

  function normalizeRecords(records) {
    const normalized = [];
    for (const raw of Array.isArray(records) ? records : []) {
      const previous = normalized.length ? normalized[normalized.length - 1] : null;
      normalized.push(createRecord({
        ...raw,
        at: raw.at || Date.parse(raw.timestamp || '') || Date.now(),
        previousHash: raw.previousHash ?? previous?.hash ?? null,
        previousDifficulty: raw.previousDifficulty ?? previous?.difficulty ?? null,
        previousAt: raw.previousAt ?? previous?.at ?? null,
        sessionHashes: raw.sessionHashes ?? raw.totalHashes ?? null,
        workSource: raw.workSource || 'synthetic-local',
        submissionStatus: raw.submissionStatus || 'not-submitted',
        blockCandidateStatus: raw.blockCandidateStatus || 'ineligible-synthetic-work'
      }));
    }
    return normalized;
  }

  function sameNetworkBlock(scope, network) {
    if (!scope || !network) return false;
    if (scope.tipHash && network.tipHash) return scope.tipHash === network.tipHash;
    if (scope.height != null && network.height != null) return Number(scope.height) === Number(network.height);
    return false;
  }

  function createBlockScope(network, at = Date.now()) {
    return {
      height: integerOrNull(network?.height),
      tipHash: network?.tipHash ? String(network.tipHash) : null,
      startedAt: Number(at) || Date.now(),
      hashes: 0,
      best: null,
      worst: null
    };
  }

  function reconcileBlockScope(scope, network, at = Date.now()) {
    if (sameNetworkBlock(scope, network)) return { scope, reset: false };
    return { scope: createBlockScope(network, at), reset: true };
  }

  return {
    SCHEMA_VERSION,
    createRecord,
    normalizeRecords,
    targetPercentage,
    improvementMultiplier,
    sameNetworkBlock,
    createBlockScope,
    reconcileBlockScope
  };
});
