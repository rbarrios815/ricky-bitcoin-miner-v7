'use strict';

(function bootstrapDashboardEnhancements(global) {
  const DISPLAY_TIME_ZONE = 'America/Chicago';
  const DIFF1_EXPECTED_HASHES = 2 ** 32;
  const state = { minuteKey: null, minuteSeconds: new Map(), jobId: null, jobStartSessionHashes: 0, samples: [] };

  function withCentralTime(options = {}) { return { ...options, timeZone: DISPLAY_TIME_ZONE, timeZoneName: options.timeZoneName || 'short' }; }
  function patchDateLocaleMethods() {
    const originalTime = Date.prototype.toLocaleTimeString;
    const originalDateTime = Date.prototype.toLocaleString;
    Date.prototype.toLocaleTimeString = function patchedTime(locales, options) { return originalTime.call(this, locales || 'en-US', withCentralTime(options)); };
    Date.prototype.toLocaleString = function patchedDateTime(locales, options) { return originalDateTime.call(this, locales || 'en-US', withCentralTime(options)); };
  }
  function formatCentralDateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(date);
  }
  function formatHashrate(value) {
    let number = Number(value) || 0;
    const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
    let index = 0;
    while (number >= 1000 && index < units.length - 1) { number /= 1000; index += 1; }
    return `${number.toFixed(number >= 100 ? 0 : number >= 10 ? 1 : 2)} ${units[index]}`;
  }
  function formatCount(value) { return Math.max(0, Number(value) || 0).toLocaleString(); }
  function formatDifficulty(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '—';
    if (number >= 1e12) return number.toExponential(3);
    if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
    if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
    if (number >= 1e3) return `${(number / 1e3).toFixed(2)}K`;
    return number.toLocaleString(undefined, { maximumSignificantDigits: 6 });
  }
  function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1000) return `${Math.round(value)} ms`;
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  function probabilityFromHashes(hashes, difficulty) {
    const attempts = Math.max(0, Number(hashes) || 0);
    const targetDifficulty = Number(difficulty);
    if (!(targetDifficulty > 0) || attempts <= 0) return { expected: 0, probability: 0 };
    const expected = attempts / (targetDifficulty * DIFF1_EXPECTED_HASHES);
    return { expected, probability: -Math.expm1(-expected) };
  }
  function formatExpected(value) {
    const number = Number(value) || 0;
    if (number === 0) return '0';
    if (number < 0.000001) return number.toExponential(3);
    if (number < 0.01) return number.toFixed(6);
    return number.toLocaleString(undefined, { maximumSignificantDigits: 5 });
  }
  function formatProbability(value) {
    const percent = Math.max(0, Math.min(1, Number(value) || 0)) * 100;
    if (percent === 0) return '0%';
    if (percent < 0.000001) return `${percent.toExponential(3)}%`;
    if (percent < 0.01) return `${percent.toFixed(6)}%`;
    return `${percent.toFixed(3)}%`;
  }
  function minuteKey(epochSeconds) { return Math.floor(Number(epochSeconds) / 60); }
  function updateMinute(second) {
    if (!second || !Number.isFinite(Number(second.second))) return;
    const key = minuteKey(second.second);
    if (state.minuteKey !== key) { state.minuteKey = key; state.minuteSeconds.clear(); }
    state.minuteSeconds.set(Number(second.second), second);
  }
  function minuteSummary() {
    const seconds = [...state.minuteSeconds.values()];
    if (!seconds.length) return null;
    let count = 0, best = null, worst = null, weightedMedianPercentile = 0, medianWeight = 0;
    for (const second of seconds) {
      const secondCount = Math.max(0, Number(second.count) || 0);
      count += secondCount;
      if (second.best && (!best || Number(second.best.difficulty) > Number(best.difficulty))) best = second.best;
      if (second.worst && (!worst || Number(second.worst.difficulty) < Number(worst.difficulty))) worst = second.worst;
      if (second.median && Number.isFinite(Number(second.median.percentile))) {
        const weight = Math.max(1, secondCount);
        weightedMedianPercentile += Number(second.median.percentile) * weight;
        medianWeight += weight;
      }
    }
    return { count, best, worst, approximateMedianPercentile: medianWeight ? weightedMedianPercentile / medianWeight : null, minuteStart: state.minuteKey * 60 * 1000 };
  }
  function average(samples) { return samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length : 0; }
  function standardDeviation(samples, mean) {
    if (samples.length < 2 || mean <= 0) return 0;
    return Math.sqrt(samples.reduce((sum, sample) => sum + ((sample.value - mean) ** 2), 0) / samples.length);
  }
  function addHashrateSample(value, now = Date.now()) {
    state.samples.push({ at: now, value: Math.max(0, Number(value) || 0) });
    state.samples = state.samples.filter(sample => now - sample.at <= 300000);
  }
  function rollingHealth(now = Date.now()) {
    const oneMinute = state.samples.filter(sample => now - sample.at <= 60000);
    const avg60 = average(oneMinute), avg300 = average(state.samples), deviation = standardDeviation(oneMinute, avg60);
    return { avg60, avg300, stabilityPercent: avg60 > 0 ? Math.max(0, 100 - (deviation / avg60 * 100)) : 0 };
  }
  function latestShareMetrics(status) {
    const records = Array.isArray(status.records) ? status.records : [];
    const latest = records.filter(record => Number(record.respondedAt) > 0 && Number(record.submittedAt) > 0).sort((a, b) => Number(b.respondedAt) - Number(a.respondedAt))[0] || null;
    return { latencyMs: latest ? Number(latest.respondedAt) - Number(latest.submittedAt) : null, responseAgeMs: latest ? Date.now() - Number(latest.respondedAt) : null };
  }
  function ensureUi() {
    if (document.getElementById('minuteBestDiff')) return;
    const grid = document.querySelector('main.grid');
    const currentSecondPanel = document.getElementById('secBestDiff')?.closest('.panel');
    if (!grid || !currentSecondPanel) return;
    const minuteCards = document.createElement('div');
    minuteCards.className = 'enhancement-fragment';
    minuteCards.innerHTML = `<section class="panel stat"><div class="label">Best hash · current minute</div><div id="minuteBestDiff" class="value blue">—</div><div id="minuteBestHash" class="hash">—</div></section><section class="panel stat"><div class="label">Median · current minute</div><div id="minuteMedian" class="value amber">—</div><div class="sub">Approximate, weighted from exact per-second medians.</div></section><section class="panel stat"><div class="label">Worst hash · current minute</div><div id="minuteWorstDiff" class="value red">—</div><div id="minuteWorstHash" class="hash">—</div></section><section class="panel stat"><div class="label">Hashes in current minute</div><div id="minuteCount" class="value">0</div><div id="minuteClock" class="sub">Waiting for live hashes.</div></section>`;
    document.getElementById('secCount')?.closest('.panel')?.after(...minuteCards.children);
    const progressPanel = document.createElement('section');
    progressPanel.className = 'panel full';
    progressPanel.innerHTML = `<div class="section-head"><div><div class="label">Statistical mining progress</div><h2>Probability ladder</h2></div><div class="sub">Probability, not accumulated completion</div></div><p class="field-note">Each row estimates expected qualifying results and the chance of at least one result at the current pool and Bitcoin network difficulties.</p><div class="table-wrap probability-wrap"><table class="probability-table"><thead><tr><th>Scope</th><th>Hashes</th><th>Expected pool shares</th><th>Pool-share chance</th><th>Expected blocks</th><th>Bitcoin-block chance</th></tr></thead><tbody id="probabilityBody"></tbody></table></div>`;
    document.getElementById('chart')?.closest('.panel')?.before(progressPanel);
    const healthPanel = document.createElement('section');
    healthPanel.className = 'panel full';
    healthPanel.innerHTML = `<div class="section-head"><div><div class="label">Mining health</div><h2>Rolling performance and pool response</h2></div><div id="healthUpdated" class="sub">Waiting for telemetry.</div></div><div class="stats-strip"><div class="mini"><span>Hashrate now</span><strong id="healthNow">—</strong></div><div class="mini"><span>60-second average</span><strong id="health60">—</strong></div><div class="mini"><span>5-minute average</span><strong id="health300">—</strong></div><div class="mini"><span>60-second stability</span><strong id="healthStability">—</strong></div><div class="mini"><span>Hashes on current job</span><strong id="jobHashes">0</strong></div><div class="mini"><span>Current job age</span><strong id="jobAge">—</strong></div><div class="mini"><span>Last fresh hash batch</span><strong id="freshBatch">—</strong></div><div class="mini"><span>Accepted-share rate</span><strong id="acceptRate">—</strong></div><div class="mini"><span>Rejected-share rate</span><strong id="rejectRate">—</strong></div><div class="mini"><span>Last response latency</span><strong id="responseLatency">—</strong></div><div class="mini"><span>Last pool response</span><strong id="responseAge">—</strong></div><div class="mini"><span>Record improvement</span><strong id="recordImprovement">—</strong></div></div>`;
    progressPanel.after(healthPanel);
  }
  function renderMinute() {
    const summary = minuteSummary();
    if (!summary) return;
    document.getElementById('minuteBestDiff').textContent = summary.best ? `Diff ${formatDifficulty(summary.best.difficulty)}` : '—';
    document.getElementById('minuteBestHash').textContent = summary.best?.hash || '—';
    document.getElementById('minuteMedian').textContent = summary.approximateMedianPercentile == null ? '—' : `${summary.approximateMedianPercentile.toFixed(3)}%`;
    document.getElementById('minuteWorstDiff').textContent = summary.worst ? `Diff ${formatDifficulty(summary.worst.difficulty)}` : '—';
    document.getElementById('minuteWorstHash').textContent = summary.worst?.hash || '—';
    document.getElementById('minuteCount').textContent = formatCount(summary.count);
    document.getElementById('minuteClock').textContent = `Minute starting ${formatCentralDateTime(summary.minuteStart)}`;
  }
  function scopeRows(status) {
    if (status.jobId !== state.jobId) { state.jobId = status.jobId; state.jobStartSessionHashes = Number(status.sessionHashes || 0); }
    const jobHashes = Math.max(0, Number(status.sessionHashes || 0) - state.jobStartSessionHashes);
    return [['Current job', jobHashes], ['Current Bitcoin block', Number(status.currentBlock?.hashes || 0)], ['Session', Number(status.sessionHashes || 0)], ['Lifetime', Number(status.lifetimeHashes || 0)]];
  }
  function renderProbability(status) {
    const body = document.getElementById('probabilityBody');
    if (!body) return;
    const poolDifficulty = Number(status.poolDifficulty || 0), networkDifficulty = Number(status.networkDifficulty || 0);
    body.innerHTML = scopeRows(status).map(([label, hashes]) => {
      const pool = probabilityFromHashes(hashes, poolDifficulty), network = probabilityFromHashes(hashes, networkDifficulty);
      return `<tr><td>${label}</td><td>${formatCount(hashes)}</td><td>${formatExpected(pool.expected)}</td><td>${formatProbability(pool.probability)}</td><td>${formatExpected(network.expected)}</td><td>${formatProbability(network.probability)}</td></tr>`;
    }).join('');
  }
  function renderHealth(status) {
    addHashrateSample(status.hashrateHps);
    const health = rollingHealth(), totalResults = Number(status.accepted || 0) + Number(status.rejected || 0), share = latestShareMetrics(status), jobHashes = scopeRows(status)[0][1], best = status.bestRecord;
    document.getElementById('healthNow').textContent = formatHashrate(status.hashrateHps);
    document.getElementById('health60').textContent = formatHashrate(health.avg60);
    document.getElementById('health300').textContent = formatHashrate(health.avg300);
    document.getElementById('healthStability').textContent = state.samples.length < 2 ? 'Collecting samples' : `${health.stabilityPercent.toFixed(1)}%`;
    document.getElementById('jobHashes').textContent = formatCount(jobHashes);
    document.getElementById('jobAge').textContent = status.jobReceivedAt ? formatDuration(Date.now() - Number(status.jobReceivedAt)) : '—';
    document.getElementById('freshBatch').textContent = status.lastHashBatchAt ? `${formatDuration(Date.now() - Number(status.lastHashBatchAt))} ago` : 'No batch yet';
    document.getElementById('acceptRate').textContent = totalResults ? `${(Number(status.accepted || 0) / totalResults * 100).toFixed(2)}%` : 'No results';
    document.getElementById('rejectRate').textContent = totalResults ? `${(Number(status.rejected || 0) / totalResults * 100).toFixed(2)}%` : 'No results';
    document.getElementById('responseLatency').textContent = share.latencyMs == null ? 'No response yet' : formatDuration(share.latencyMs);
    document.getElementById('responseAge').textContent = share.responseAgeMs == null ? 'No response yet' : `${formatDuration(share.responseAgeMs)} ago`;
    document.getElementById('recordImprovement').textContent = best?.improvementMultiplier ? `${Number(best.improvementMultiplier).toLocaleString(undefined, { maximumSignificantDigits: 5 })}×` : best ? 'First saved record' : 'No record yet';
    document.getElementById('healthUpdated').textContent = `Updated ${formatCentralDateTime(Date.now())}`;
  }
  function rewriteVisibleRecordTimes() {
    document.querySelectorAll('#recordBody tr td:first-child').forEach(cell => {
      const raw = cell.dataset.utcTimestamp || cell.textContent.trim();
      if (!cell.dataset.utcTimestamp && /^\d{4}-\d{2}-\d{2}T/.test(raw)) cell.dataset.utcTimestamp = raw;
      if (cell.dataset.utcTimestamp) cell.textContent = formatCentralDateTime(cell.dataset.utcTimestamp);
    });
  }
  async function refresh() {
    ensureUi();
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (!response.ok) return;
      const status = await response.json();
      updateMinute(status.currentSecond);
      renderMinute(); renderProbability(status); renderHealth(status); rewriteVisibleRecordTimes();
    } catch (_) {}
  }
  patchDateLocaleMethods();
  global.RickyMiningProgress = { probabilityFromHashes, minuteKey, formatCentralDateTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.RickyMiningProgress;
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { ensureUi(); refresh(); setInterval(refresh, 1000); new MutationObserver(rewriteVisibleRecordTimes).observe(document.body, { childList: true, subtree: true }); });
})(typeof window !== 'undefined' ? window : globalThis);
