'use strict';

const $ = id => document.getElementById(id);
const elements = {
  helperBadge: $('helperBadge'), eligibilityBadge: $('eligibilityBadge'), eligibilityNotice: $('eligibilityNotice'), eligibilityReason: $('eligibilityReason'),
  address: $('address'), addressStatus: $('addressStatus'), workerName: $('workerName'), threads: $('threads'), pool: $('pool'),
  startBtn: $('startBtn'), stopBtn: $('stopBtn'), exportBtn: $('exportBtn'), clearRecordsBtn: $('clearRecordsBtn'), nativeStatus: $('nativeStatus'),
  hashrate: $('hashrate'), sessionHashes: $('sessionHashes'), lifetimeHashes: $('lifetimeHashes'), runtime: $('runtime'),
  secBestDiff: $('secBestDiff'), secBestHash: $('secBestHash'), secMedian: $('secMedian'), secMedianHash: $('secMedianHash'), secWorstDiff: $('secWorstDiff'), secWorstHash: $('secWorstHash'), secCount: $('secCount'), secClock: $('secClock'),
  blockKey: $('blockKey'), blockHeight: $('blockHeight'), blockHashes: $('blockHashes'), blockBest: $('blockBest'), blockAge: $('blockAge'), jobId: $('jobId'),
  bestDifficulty: $('bestDifficulty'), bestHash: $('bestHash'), bestMeta: $('bestMeta'), worstDifficulty: $('worstDifficulty'), worstHash: $('worstHash'), worstMeta: $('worstMeta'),
  connectionState: $('connectionState'), subscriptionState: $('subscriptionState'), authorizationState: $('authorizationState'), submissionState: $('submissionState'), poolDifficulty: $('poolDifficulty'), networkDifficulty: $('networkDifficulty'), sharesSubmitted: $('sharesSubmitted'), shareResults: $('shareResults'), blockCandidates: $('blockCandidates'), networkTarget: $('networkTarget'),
  networkStatus: $('networkStatus'), chart: $('chart'), gapPool: $('gapPool'), gapNetwork: $('gapNetwork'), targetPercent: $('targetPercent'), sinceBest: $('sinceBest'), avgRecordTime: $('avgRecordTime'),
  recordBody: $('recordBody'), log: $('log'), clearLogBtn: $('clearLogBtn')
};

let currentStatus = null;
let observedHeight = null;
let eventSource = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function formatNumber(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value === Infinity ? '∞' : '—';
  if (number === 0) return '0';
  const absolute = Math.abs(number);
  if (absolute >= 1e12 || absolute < 1e-6) return number.toExponential(digits);
  if (absolute >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (absolute >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (absolute >= 1e3) return `${(number / 1e3).toFixed(2)}K`;
  return number.toLocaleString(undefined, { maximumSignificantDigits: digits + 2 });
}

function formatHashrate(value) {
  let number = Number(value) || 0;
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s'];
  let index = 0;
  while (number >= 1000 && index < units.length - 1) {
    number /= 1000;
    index += 1;
  }
  return `${number.toFixed(number >= 100 ? 0 : number >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number === 0) return '0%';
  if (Math.abs(number) < 0.000001) return `${number.toExponential(5)}%`;
  return `${number.toFixed(number < 0.01 ? 6 : 3)}%`;
}

function formatRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '—';
  if (number >= 1e9) return `${number.toExponential(3)}× harder`;
  return `${number.toLocaleString(undefined, { maximumSignificantDigits: 5 })}× harder`;
}

function shortHash(value, length = 12) {
  const text = String(value || '');
  if (!text) return '—';
  return text.length <= length * 2 ? text : `${text.slice(0, length)}…${text.slice(-length)}`;
}

function appendLog(entry) {
  const timestamp = entry.at ? new Date(entry.at).toLocaleTimeString() : new Date().toLocaleTimeString();
  if (elements.log.textContent === 'Waiting for the local helper…') elements.log.textContent = '';
  elements.log.textContent += `[${timestamp}] ${entry.source || 'system'}: ${entry.line}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function postJson(url, body = {}) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function validateAddress() {
  const value = elements.address.value.trim();
  if (!value) {
    elements.addressStatus.textContent = 'Enter a public Bitcoin mainnet payout address.';
    elements.addressStatus.className = 'field-note bad';
    return false;
  }
  try {
    const result = await postJson('/api/validate-address', { address: value });
    elements.addressStatus.textContent = result.valid ? 'Valid Bitcoin mainnet address.' : 'Invalid Bitcoin mainnet address or checksum.';
    elements.addressStatus.className = result.valid ? 'field-note good' : 'field-note bad';
    return result.valid;
  } catch (error) {
    elements.addressStatus.textContent = error.message;
    elements.addressStatus.className = 'field-note bad';
    return false;
  }
}

function renderEligibility(status) {
  const eligibility = status.eligibility || {};
  elements.eligibilityReason.textContent = eligibility.reason || 'Unknown eligibility state';
  if (eligibility.eligible) {
    elements.eligibilityBadge.textContent = 'REWARD-ELIGIBLE WORK ACTIVE';
    elements.eligibilityBadge.className = 'badge good';
    elements.eligibilityNotice.className = 'notice good';
    elements.eligibilityNotice.querySelector('strong').textContent = 'Reward-eligible work active:';
  } else {
    elements.eligibilityBadge.textContent = 'NOT REWARD ELIGIBLE';
    elements.eligibilityBadge.className = 'badge bad';
    elements.eligibilityNotice.className = 'notice danger';
    elements.eligibilityNotice.querySelector('strong').textContent = 'Not reward eligible:';
  }
}

function statusLabel(status) {
  if (!status.running) return 'Stopped';
  if (!status.connected) return 'Connecting';
  if (!status.subscribed) return 'Subscribing';
  if (!status.authorized) return 'Authorizing';
  if (!status.jobId) return 'Waiting for live job';
  if (!status.currentWork) return 'Constructing live work';
  if (!status.submissionReady) return 'Submission path unavailable';
  if (!status.eligibility?.eligible) return status.eligibility?.reason || 'Waiting for verified live hashing';
  return 'Hashing live reward-eligible work';
}

function renderSecond(status) {
  const second = status.currentSecond;
  if (!second) {
    elements.secBestDiff.textContent = '—'; elements.secBestHash.textContent = '—';
    elements.secMedian.textContent = '—'; elements.secMedianHash.textContent = '—';
    elements.secWorstDiff.textContent = '—'; elements.secWorstHash.textContent = '—';
    elements.secCount.textContent = '0'; elements.secClock.textContent = 'Waiting for live hashes.';
    return;
  }
  elements.secBestDiff.textContent = `Diff ${formatNumber(second.best?.difficulty, 5)}`;
  elements.secBestHash.textContent = second.best?.hash || '—';
  elements.secMedian.textContent = second.median ? `${second.median.percentile.toFixed(3)}%` : '—';
  elements.secMedianHash.textContent = second.median ? `≈ ${second.median.approximateHashPrefix}… (53-bit ordered prefix)` : '—';
  elements.secWorstDiff.textContent = `Diff ${formatNumber(second.worst?.difficulty, 5)}`;
  elements.secWorstHash.textContent = second.worst?.hash || '—';
  elements.secCount.textContent = Number(second.count || 0).toLocaleString();
  elements.secClock.textContent = `Measured bucket ${new Date(second.second * 1000).toLocaleTimeString()}`;
}

function renderBlock(status) {
  const block = status.currentBlock;
  elements.blockKey.textContent = block?.prevhash ? `Prevhash ${shortHash(block.prevhash, 16)}` : 'No live block work';
  elements.blockHeight.textContent = observedHeight == null ? 'Unknown' : Number(observedHeight).toLocaleString();
  elements.blockHashes.textContent = Number(block?.hashes || 0).toLocaleString();
  elements.blockBest.textContent = block?.best ? `Diff ${formatNumber(block.best.difficulty, 5)}` : '—';
  elements.blockAge.textContent = block?.startedAt ? formatDuration(Date.now() - Number(block.startedAt)) : '—';
  elements.jobId.textContent = status.jobId || '—';
}

function renderExtrema(status) {
  const best = status.bestRecord;
  elements.bestDifficulty.textContent = best ? `Diff ${formatNumber(best.difficulty, 6)}` : '—';
  elements.bestHash.textContent = best?.hash || '—';
  elements.bestMeta.textContent = best
    ? `${new Date(best.at).toLocaleString()} · lifetime hash #${Number(best.lifetimeHashes || 0).toLocaleString()}`
    : 'No record yet.';
  const worst = status.worstRecord;
  elements.worstDifficulty.textContent = worst ? `Diff ${formatNumber(worst.difficulty, 6)}` : '—';
  elements.worstHash.textContent = worst?.hash || '—';
  elements.worstMeta.textContent = worst
    ? `${new Date(worst.at).toLocaleString()} · lifetime hash #${Number(worst.lifetimeHashes || 0).toLocaleString()}`
    : 'No record yet.';
}

function outcomeText(record) {
  if (record.shareAccepted) return 'Accepted by pool';
  if (record.submitted) return record.submissionStatus || 'Submitted';
  return record.submissionStatus || 'Below pool target';
}

function candidateText(record) {
  if (!record.blockCandidate) return 'No';
  return record.blockCandidateStatus || 'Candidate';
}

function renderRecords(status) {
  const records = Array.isArray(status.records) ? status.records.slice().reverse() : [];
  if (!records.length) {
    elements.recordBody.innerHTML = '<tr><td colspan="11">No record-breaking hashes yet.</td></tr>';
    return;
  }
  elements.recordBody.innerHTML = records.map(record => {
    const previous = record.previousDifficulty == null
      ? 'First saved record'
      : `Diff ${escapeHtml(formatNumber(record.previousDifficulty, 5))}<br><span class="hash small">${escapeHtml(shortHash(record.previousHash))}</span>`;
    const counts = `S ${Number(record.sessionHashes || 0).toLocaleString()}<br>L ${Number(record.lifetimeHashes || 0).toLocaleString()}<br>B ${Number(record.currentBlockHashes || 0).toLocaleString()}`;
    const context = `job ${escapeHtml(shortHash(record.jobId, 10))}<br>worker ${escapeHtml(record.workerId)} · nonce ${Number(record.nonce || 0).toLocaleString()}<br>x2 ${escapeHtml(record.extranonce2 || '—')}`;
    const performance = `${formatHashrate(record.hashrate)}<br>${formatDuration(record.runtimeMs)}`;
    return `<tr>
      <td>${escapeHtml(record.timestamp)}</td>
      <td>${escapeHtml(formatNumber(record.difficulty, 7))}</td>
      <td class="hash">${escapeHtml(record.hash)}</td>
      <td>${previous}</td>
      <td>${record.improvementMultiplier == null ? '—' : `${escapeHtml(formatNumber(record.improvementMultiplier, 6))}×`}</td>
      <td>Diff ${escapeHtml(formatNumber(record.networkDifficulty, 5))}<br>${escapeHtml(formatPercent(record.targetPercentage))}</td>
      <td>${counts}</td>
      <td>${context}</td>
      <td>${escapeHtml(outcomeText(record))}<br><span class="sub">eligible at hash: ${record.rewardEligibleAtHash ? 'yes' : 'no'}</span></td>
      <td>${escapeHtml(candidateText(record))}</td>
      <td>${performance}</td>
    </tr>`;
  }).join('');
}

function renderProgress(status) {
  const best = Number(status.bestRecord?.difficulty || 0);
  const pool = Number(status.poolDifficulty || 0);
  const network = Number(status.networkDifficulty || 0);
  elements.gapPool.textContent = best > 0 && pool > 0 ? (best >= pool ? 'Reached' : formatRatio(pool / best)) : '—';
  elements.gapNetwork.textContent = best > 0 && network > 0 ? (best >= network ? 'Reached' : formatRatio(network / best)) : '—';
  elements.targetPercent.textContent = best > 0 && network > 0 ? formatPercent(best / network * 100) : '—';
  elements.sinceBest.textContent = status.bestRecord?.at ? formatDuration(Date.now() - Number(status.bestRecord.at)) : '—';
  const records = Array.isArray(status.records) ? status.records : [];
  if (records.length >= 2) {
    const total = Number(records.at(-1).at) - Number(records[0].at);
    elements.avgRecordTime.textContent = formatDuration(total / (records.length - 1));
  } else {
    elements.avgRecordTime.textContent = records.length ? 'Need 2 records' : '—';
  }
  drawChart(records, pool, network);
}

function drawChart(records = currentStatus?.records || [], pool = currentStatus?.poolDifficulty, network = currentStatus?.networkDifficulty) {
  const canvas = elements.chart;
  const context = canvas.getContext('2d');
  const rectangle = canvas.getBoundingClientRect();
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(600, Math.floor(rectangle.width * pixelRatio));
  const height = Math.max(280, Math.floor(rectangle.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#071624'; context.fillRect(0, 0, width, height);
  const padding = { left: 70 * pixelRatio, right: 22 * pixelRatio, top: 22 * pixelRatio, bottom: 40 * pixelRatio };
  const points = records.slice(-300).filter(record => Number(record.difficulty) > 0);
  const values = points.map(point => Number(point.difficulty)).concat(Number(pool) > 0 ? [Number(pool)] : []).concat(Number(network) > 0 ? [Number(network)] : []);
  if (!values.length) {
    context.fillStyle = '#91a7bd'; context.font = `${15 * pixelRatio}px system-ui`;
    context.fillText('Start live mining to build the record chart.', padding.left, height / 2);
    return;
  }
  let minimumLog = Math.floor(Math.min(...values.map(Math.log10), -12));
  let maximumLog = Math.ceil(Math.max(...values.map(Math.log10), 0));
  if (maximumLog - minimumLog < 4) { maximumLog += 2; minimumLog -= 2; }
  const x = index => padding.left + (points.length <= 1 ? 0.5 : index / (points.length - 1)) * (width - padding.left - padding.right);
  const y = value => padding.top + (maximumLog - Math.log10(Math.max(value, 1e-18))) / (maximumLog - minimumLog) * (height - padding.top - padding.bottom);
  context.strokeStyle = '#1f3b54'; context.lineWidth = pixelRatio; context.fillStyle = '#8fa8bd'; context.font = `${11 * pixelRatio}px system-ui`;
  const step = Math.max(1, Math.ceil((maximumLog - minimumLog) / 8));
  for (let power = minimumLog; power <= maximumLog; power += step) {
    const vertical = y(10 ** power); context.beginPath(); context.moveTo(padding.left, vertical); context.lineTo(width - padding.right, vertical); context.stroke(); context.fillText(`1e${power}`, 8 * pixelRatio, vertical + 4 * pixelRatio);
  }
  function targetLine(value, color, label) {
    if (!(Number(value) > 0)) return;
    const vertical = y(Number(value)); context.strokeStyle = color; context.setLineDash([7 * pixelRatio, 5 * pixelRatio]); context.beginPath(); context.moveTo(padding.left, vertical); context.lineTo(width - padding.right, vertical); context.stroke(); context.setLineDash([]); context.fillStyle = color; context.fillText(label, padding.left + 6 * pixelRatio, Math.max(14 * pixelRatio, vertical - 5 * pixelRatio));
  }
  targetLine(pool, '#ffb72b', 'Pool share target'); targetLine(network, '#ff5d73', 'Bitcoin network target');
  if (points.length) {
    context.strokeStyle = '#3da5ff'; context.lineWidth = 2 * pixelRatio; context.beginPath();
    points.forEach((point, index) => { const horizontal = x(index); const vertical = y(Number(point.difficulty)); if (index) context.lineTo(horizontal, vertical); else context.moveTo(horizontal, vertical); }); context.stroke();
  }
}

function updateStatus(status) {
  currentStatus = status;
  elements.helperBadge.textContent = 'Local helper connected';
  elements.helperBadge.className = 'badge good';
  renderEligibility(status);
  elements.nativeStatus.textContent = statusLabel(status);
  elements.hashrate.textContent = formatHashrate(status.hashrateHps);
  elements.sessionHashes.textContent = Number(status.sessionHashes || 0).toLocaleString();
  elements.lifetimeHashes.textContent = Number(status.lifetimeHashes || 0).toLocaleString();
  elements.connectionState.textContent = status.connected ? 'Connected' : 'Disconnected';
  elements.subscriptionState.textContent = status.subscribed ? 'Yes' : 'No';
  elements.authorizationState.textContent = status.authorized ? 'Yes' : 'No';
  elements.submissionState.textContent = status.submissionReady ? 'Ready' : 'No';
  elements.poolDifficulty.textContent = status.poolDifficulty == null ? '—' : formatNumber(status.poolDifficulty, 5);
  elements.networkDifficulty.textContent = status.networkDifficulty == null ? '—' : formatNumber(status.networkDifficulty, 5);
  elements.sharesSubmitted.textContent = Number(status.sharesSubmitted || 0).toLocaleString();
  elements.shareResults.textContent = `${Number(status.accepted || 0).toLocaleString()} / ${Number(status.rejected || 0).toLocaleString()}`;
  elements.blockCandidates.textContent = `${Number(status.blockCandidates || 0).toLocaleString()} (${Number(status.acceptedBlockCandidates || 0)} pool accepted)`;
  elements.networkTarget.textContent = status.networkTarget || '—';
  elements.startBtn.disabled = Boolean(status.running);
  elements.stopBtn.disabled = !status.running;
  elements.threads.max = String(status.logicalCpus || 1);
  renderSecond(status); renderBlock(status); renderExtrema(status); renderRecords(status); renderProgress(status);
}

async function startMining() {
  if (!await validateAddress()) return;
  elements.startBtn.disabled = true;
  try {
    const result = await postJson('/api/start', {
      address: elements.address.value.trim(), worker: elements.workerName.value.trim(), pool: elements.pool.value, threads: Number(elements.threads.value)
    });
    updateStatus(result.state || await requestJson('/api/status'));
  } catch (error) {
    appendLog({ source: 'error', line: error.message });
    alert(error.message);
    elements.startBtn.disabled = false;
  }
}

async function stopMining() {
  try {
    await postJson('/api/stop');
    updateStatus(await requestJson('/api/status'));
  } catch (error) { appendLog({ source: 'error', line: error.message }); }
}

function csvValue(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
function exportCsv() {
  const records = currentStatus?.records || [];
  const columns = ['timestamp','difficulty','hash','previous_hash','previous_difficulty','improvement_multiplier','network_difficulty','network_target','target_percentage','pool_difficulty','share_target','session_hashes','lifetime_hashes','current_block_hashes','job_id','network_block_key','generation','extranonce2','ntime','version','worker_id','nonce','work_source','reward_eligible_at_hash','submitted','submission_status','share_accepted','block_candidate','block_candidate_status','meets_network_difficulty','hashrate_hs','runtime_ms'];
  const rows = [columns];
  for (const record of records) rows.push(columns.map(column => ({
    timestamp:record.timestamp,difficulty:record.difficulty,hash:record.hash,previous_hash:record.previousHash,previous_difficulty:record.previousDifficulty,improvement_multiplier:record.improvementMultiplier,network_difficulty:record.networkDifficulty,network_target:record.networkTarget,target_percentage:record.targetPercentage,pool_difficulty:record.poolDifficulty,share_target:record.shareTarget,session_hashes:record.sessionHashes,lifetime_hashes:record.lifetimeHashes,current_block_hashes:record.currentBlockHashes,job_id:record.jobId,network_block_key:record.networkBlockKey,generation:record.generation,extranonce2:record.extranonce2,ntime:record.ntime,version:record.version,worker_id:record.workerId,nonce:record.nonce,work_source:record.workSource,reward_eligible_at_hash:record.rewardEligibleAtHash,submitted:record.submitted,submission_status:record.submissionStatus,share_accepted:record.shareAccepted,block_candidate:record.blockCandidate,block_candidate_status:record.blockCandidateStatus,meets_network_difficulty:record.meetsNetworkDifficulty,hashrate_hs:record.hashrate,runtime_ms:record.runtimeMs
  })[column]));
  const blob = new Blob([rows.map(row => row.map(csvValue).join(',')).join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ricky-bitcoin-reward-miner-records.csv'; anchor.click(); URL.revokeObjectURL(url);
}

async function clearRecords() {
  if (!confirm('Clear saved best/worst records and current-block history? Lifetime hash count will remain.')) return;
  try {
    await postJson('/api/clear-records');
    updateStatus(await requestJson('/api/status'));
  } catch (error) { alert(error.message); }
}

async function loadNetwork() {
  try {
    const data = await requestJson('/api/network');
    observedHeight = data.height;
    const sourceLabel = Array.isArray(data.sources) && data.sources.length ? data.sources.join(', ') : 'live public sources';
    elements.networkStatus.textContent = data.height == null ? `Network height unavailable · ${sourceLabel}` : `Height ${Number(data.height).toLocaleString()} · ${sourceLabel}`;
    if (currentStatus) renderBlock(currentStatus);
  } catch (_) { elements.networkStatus.textContent = 'Observed network height unavailable; live Stratum target remains authoritative.'; }
}

function connectEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('state', event => updateStatus(JSON.parse(event.data)));
  eventSource.addEventListener('log', event => appendLog(JSON.parse(event.data)));
  eventSource.onerror = () => {
    elements.helperBadge.textContent = 'Local helper disconnected'; elements.helperBadge.className = 'badge bad';
  };
}

function updateClocks() {
  if (currentStatus?.running && currentStatus.startedAt) elements.runtime.textContent = formatDuration(Date.now() - new Date(currentStatus.startedAt).getTime());
  else elements.runtime.textContent = '0s';
  if (currentStatus) { renderBlock(currentStatus); renderProgress(currentStatus); }
}

async function init() {
  elements.startBtn.addEventListener('click', startMining); elements.stopBtn.addEventListener('click', stopMining); elements.exportBtn.addEventListener('click', exportCsv); elements.clearRecordsBtn.addEventListener('click', clearRecords); elements.clearLogBtn.addEventListener('click', () => { elements.log.textContent = ''; });
  elements.address.addEventListener('change', validateAddress); window.addEventListener('resize', () => drawChart());
  await validateAddress();
  try {
    const status = await requestJson('/api/status');
    if (status.logs?.length) { elements.log.textContent = ''; status.logs.forEach(appendLog); }
    updateStatus(status); connectEvents();
  } catch (error) {
    elements.helperBadge.textContent = 'Local helper unavailable'; elements.helperBadge.className = 'badge bad'; appendLog({ source: 'error', line: error.message });
  }
  loadNetwork(); setInterval(loadNetwork, 15000); setInterval(updateClocks, 1000);
}

init();
