function startWorkers() {
  stopWorkers();
  state.running = true;
  state.paused = false;
  state.startedAt = Date.now();
  state.rateWindow = [];

  const workerCount = Number($('workerCount').value);
  const batchSize = Number($('batchSize').value);

  for (let workerId = 0; workerId < workerCount; workerId += 1) {
    const worker = new Worker('miner-worker.js');
    worker.onmessage = (event) => {
      if (event.data?.type === 'batch') aggregateBatch(event.data);
    };
    worker.onerror = (event) => {
      console.error(event);
      $('statusText').textContent = 'Worker error';
    };

    const seed = new Uint8Array(80);
    crypto.getRandomValues(seed);
    worker.postMessage({
      type: 'start',
      workerId,
      batchSize,
      sessionId: state.sessionId,
      seed: seed.buffer
    }, [seed.buffer]);
    state.workers.push(worker);
  }

  updateControls();
}

function pauseResume() {
  if (!state.running) return;
  if (!state.paused) {
    state.elapsedBeforeStart += Date.now() - state.startedAt;
    state.startedAt = null;
    state.paused = true;
    state.workers.forEach((worker) => worker.postMessage({ type: 'pause' }));
  } else {
    state.startedAt = Date.now();
    state.paused = false;
    state.workers.forEach((worker) => worker.postMessage({ type: 'resume' }));
  }
  updateControls();
}

function stopWorkers() {
  state.workers.forEach((worker) => {
    try {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    } catch (_) {}
  });
  state.workers = [];
}

function resetSession() {
  if (state.running && !state.paused && state.startedAt) {
    state.elapsedBeforeStart += Date.now() - state.startedAt;
  }
  stopWorkers();
  state.running = false;
  state.paused = false;
  state.sessionHashes = 0;
  state.sessionId = makeSessionId();
  state.startedAt = null;
  state.elapsedBeforeStart = 0;
  state.rateWindow = [];
  state.buckets.clear();
  updateControls();
  saveState();
  render();
}

function updateControls() {
  $('startBtn').disabled = state.running;
  $('pauseBtn').disabled = !state.running;
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  $('workerCount').disabled = state.running;
  $('statusDot').classList.toggle('running', state.running && !state.paused);
  $('statusText').textContent = !state.running
    ? 'Stopped'
    : state.paused
      ? 'Paused'
      : 'Hashing locally';
}

function csvValue(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportCsv() {
  const columns = [
    'timestamp', 'difficulty', 'hash', 'previous_hash', 'previous_difficulty',
    'improvement_multiplier', 'network_difficulty', 'network_height', 'network_tip_hash',
    'target_percentage', 'session_hashes', 'lifetime_hashes', 'current_block_hashes',
    'session_id', 'job_id', 'block_template_id', 'work_source', 'worker_id', 'nonce',
    'submitted', 'submission_status', 'share_accepted', 'block_candidate',
    'block_candidate_status', 'meets_network_difficulty', 'hashrate_hs', 'runtime_ms'
  ];

  const rows = [columns];
  for (const record of state.records) {
    rows.push([
      record.timestamp, record.difficulty, record.hash, record.previousHash,
      record.previousDifficulty, record.improvementMultiplier, record.networkDifficulty,
      record.networkHeight, record.networkTipHash, record.targetPercentage,
      record.sessionHashes, record.lifetimeHashes, record.currentBlockHashes,
      record.sessionId, record.jobId, record.blockTemplateId, record.workSource,
      record.workerId, record.nonce, record.submitted, record.submissionStatus,
      record.shareAccepted, record.blockCandidate, record.blockCandidateStatus,
      record.meetsNetworkDifficulty, record.hashrate, record.runtimeMs
    ]);
  }

  const csv = rows.map((row) => row.map(csvValue).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ricky-miner-v7-record-hashes-full.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function applyNetworkSnapshot(data) {
  const difficulty = Number(data.difficulty);
  const hashrate = Number(data.networkHashrate);
  const height = Number(data.height);
  const tipHash = data.tipHash ? String(data.tipHash) : null;
  const fetchedAt = Number(data.fetchedAt) || Date.now();

  state.networkDifficulty = Number.isFinite(difficulty) ? difficulty : null;
  state.networkHashrate = Number.isFinite(hashrate) ? hashrate : null;
  state.networkHeight = Number.isInteger(height) ? height : null;
  state.networkTipHash = tipHash;
  state.networkFetchedAt = fetchedAt;

  if (tipHash || state.networkHeight != null) {
    const result = RecordUtils.reconcileBlockScope(state.currentBlock, {
      height: state.networkHeight,
      tipHash
    }, fetchedAt);
    state.currentBlock = result.scope;
    if (result.reset) saveState();
  }

  const difficultyText = state.networkDifficulty
    ? `Bitcoin difficulty ${formatNumber(state.networkDifficulty)}`
    : 'Network target unavailable';
  const heightText = state.networkHeight == null
    ? ''
    : ` · height ${state.networkHeight.toLocaleString()}`;
  const rateText = state.networkHashrate
    ? ` · estimated ${formatHashrate(state.networkHashrate)}`
    : '';
  $('networkStatus').textContent = `${difficultyText}${heightText}${rateText}`;
}

async function loadNetwork() {
  try {
    const response = await fetch('/api/network', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ${response.status}');
    applyNetworkSnapshot(await response.json());
  } catch (error) {
    $('networkStatus').textContent = 'Network data unavailable; local hashing still works.';
  }
  drawChart();
  renderCurrentBlock();
  renderProgress();
}

function drawChart() {
  const canvas = $('chart');
  const context = canvas.getContext('2d');
  const rectangle = canvas.getBoundingClientRect();
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(600, Math.floor(rectangle.width * pixelRatio));
  const height = Math.max(260, Math.floor(rectangle.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.clearRect(0, 0, width, height);
  context.fillStyle = '#071624';
  context.fillRect(0, 0, width, height);

  const padding = {
    left: 70 * pixelRatio,
    right: 22 * pixelRatio,
    top: 22 * pixelRatio,
    bottom: 40 * pixelRatio
  };
  const points = state.chartPoints.slice(-300);
  const referenceShare = Math.max(Number($('shareTarget').value) || 1, 1e-18);
  const network = state.networkDifficulty;
  const values = points.map((point) => Math.max(point.difficulty, 1e-18))
    .concat([referenceShare])
    .concat(network ? [network] : []);

  let minimumLog = Math.floor(Math.min(...values.map(Math.log10), -18));
  let maximumLog = Math.ceil(Math.max(...values.map(Math.log10), 0));
  if (maximumLog - minimumLog < 4) {
    maximumLog += 2;
    minimumLog -= 2;
  }

  const x = (index) => padding.left + (
    points.length <= 1 ? 0.5 : index / (points.length - 1)
  ) * (width - padding.left - padding.right);
  const y = (value) => padding.top + (
    maximumLog - Math.log10(Math.max(value, 1e-18))
  ) / (maximumLog - minimumLog) * (height - padding.top - padding.bottom);

  context.strokeStyle = '#1f3b54';
  context.lineWidth = 1 * pixelRatio;
  context.fillStyle = '#8fa8bd';
  context.font = `${11 * pixelRatio}px system-ui`;

  for (
    let power = minimumLog;
    power <= maximumLog;
    power += Math.max(1, Math.ceil((maximumLog - minimumLog) / 8))
  ) {
    const vertical = y(Math.pow(10, power));
    context.beginPath();
    context.moveTo(padding.left, vertical);
    context.lineTo(width - padding.right, vertical);
    context.stroke();
    context.fillText(`1e${power}`, 8 * pixelRatio, vertical + 4 * pixelRatio);
  }

  function targetLine(value, color, label) {
    if (!value) return;
    const vertical = y(value);
    context.strokeStyle = color;
    context.setLineDash([7 * pixelRatio, 5 * pixelRatio]);
    context.beginPath();
    context.moveTo(padding.left, vertical);
    context.lineTo(width - padding.right, vertical);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = color;
    context.fillText(label, padding.left + 6 * pixelRatio, Math.max(14 * pixelRatio, vertical - 5 * pixelRatio));
  }

  targetLine(referenceShare, '#ffb72b', 'Reference share target');
  targetLine(network, '#ff5d73', 'Bitcoin network target');

  if (points.length) {
    context.strokeStyle = '#3da5ff';
    context.lineWidth = 2 * pixelRatio;
    context.beginPath();
    points.forEach((point, index) => {
      const horizontal = x(index);
      const vertical = y(point.difficulty);
      if (index) context.lineTo(horizontal, vertical);
      else context.moveTo(horizontal, vertical);
    });
    context.stroke();
    context.fillStyle = '#3da5ff';
    points.forEach((point, index) => {
      context.beginPath();
      context.arc(x(index), y(point.difficulty), 2.2 * pixelRatio, 0, Math.PI * 2);
      context.fill();
    });
  } else {
    context.fillStyle = '#91a7bd';
    context.font = `${15 * pixelRatio}px system-ui`;
    context.fillText('Start hashing to build the record-progress chart.', padding.left, height / 2);
  }

  context.fillStyle = '#8fa8bd';
  context.font = `${11 * pixelRatio}px system-ui`;
  context.fillText('Record sequence →', width - 120 * pixelRatio, height - 12 * pixelRatio);
}

function initWorkerOptions() {
  const maximum = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  for (let index = 1; index <= maximum; index += 1) {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = index;
    if (index === Math.min(2, maximum)) option.selected = true;
    $('workerCount').appendChild(option);
  }
}

$('startBtn').addEventListener('click', startWorkers);
$('pauseBtn').addEventListener('click', pauseResume);
$('resetBtn').addEventListener('click', resetSession);
$('batchSize').addEventListener('change', () => {
  state.workers.forEach((worker) => worker.postMessage({
    type: 'batch-size',
    batchSize: Number($('batchSize').value)
  }));
});
$('shareTarget').addEventListener('input', () => {
  renderProgress();
  drawChart();
});
$('exportBtn').addEventListener('click', exportCsv);
$('clearRecordsBtn').addEventListener('click', () => {
  if (!confirm('Clear all saved best/worst hashes and record history for v7? Lifetime hash count will remain.')) return;
  state.best = null;
  state.worst = null;
  state.records = [];
  state.chartPoints = [];
  saveState();
  renderAllTime();
  renderRecords();
  drawChart();
  renderProgress();
});
window.addEventListener('resize', drawChart);
window.addEventListener('beforeunload', () => {
  saveState();
  stopWorkers();
});

initWorkerOptions();
loadState();
renderRecords();
renderAllTime();
renderCurrentBlock();
updateControls();
drawChart();
loadNetwork();
setInterval(render, 250);
setInterval(loadNetwork, 15 * 1000);
