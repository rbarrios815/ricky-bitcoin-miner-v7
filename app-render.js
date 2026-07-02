function computeMedian(bucket) {
  if (!bucket || !bucket.count) return null;
  if (!bucket.dirty && bucket.median != null) return bucket.median;
  const all = new Float64Array(bucket.count);
  let offset = 0;
  for (const segment of bucket.segments) {
    all.set(segment, offset);
    offset += segment.length;
  }
  all.sort();
  const middle = Math.floor(all.length / 2);
  bucket.median = all.length % 2 ? all[middle] : (all[middle - 1] + all[middle]) / 2;
  bucket.dirty = false;
  return bucket.median;
}

function medianPrefixText(value) {
  if (value == null) return { short: '—', hash: '—' };
  const aligned = BigInt(Math.floor(value)) << 3n;
  const prefix = aligned.toString(16).padStart(14, '0');
  const percentile = (value / Math.pow(2, 53)) * 100;
  return {
    short: `${percentile.toFixed(3)}%`,
    hash: `≈ ${prefix}… (53-bit ordered prefix)`
  };
}

function currentRate() {
  if (state.rateWindow.length < 2) return 0;
  const count = state.rateWindow.reduce((sum, entry) => sum + entry.count, 0);
  const span = Math.max(
    250,
    state.rateWindow.at(-1).t - state.rateWindow[0].t
  );
  return count * 1000 / span;
}

function activeElapsed() {
  return state.elapsedBeforeStart + (
    state.running && !state.paused && state.startedAt
      ? Date.now() - state.startedAt
      : 0
  );
}

function render() {
  $('hashrate').textContent = formatHashrate(currentRate());
  $('totalHashes').textContent = state.sessionHashes.toLocaleString();
  $('lifetimeHashes').textContent = state.lifetimeHashes.toLocaleString();
  $('uptime').textContent = formatDuration(activeElapsed());

  const nowSecond = Math.floor(Date.now() / 1000);
  const bucket = state.buckets.get(nowSecond) || state.buckets.get(nowSecond - 1);

  if (bucket) {
    $('secondCount').textContent = bucket.count.toLocaleString();
    $('secBestDiff').textContent = `Diff ${formatNumber(bucket.best?.difficulty)}`;
    $('secBestHash').textContent = bucket.best?.hash || '—';
    const median = medianPrefixText(computeMedian(bucket));
    $('secMedianPrefix').textContent = median.short;
    $('secMedianHash').textContent = median.hash;
    $('secWorstDiff').textContent = `Diff ${formatNumber(bucket.worst?.difficulty)}`;
    $('secWorstHash').textContent = bucket.worst?.hash || '—';

    if (bucket.best && bucket.worst) {
      const bestPrefix = BigInt(`0x${bucket.best.hash.slice(0, 16)}`);
      const worstPrefix = BigInt(`0x${bucket.worst.hash.slice(0, 16)}`);
      const span = Number(worstPrefix - bestPrefix) / Number(0xffffffffffffffffn) * 100;
      $('secSpan').textContent = `${span.toFixed(3)}%`;
    } else {
      $('secSpan').textContent = '—';
    }

    $('secClock').textContent = `Bucket ${new Date(bucket.second * 1000).toLocaleTimeString()} · ${bucket.count.toLocaleString()} hashes`;
  } else {
    $('secondCount').textContent = '0';
    for (const id of ['secBestDiff', 'secMedianPrefix', 'secWorstDiff', 'secSpan']) {
      $(id).textContent = '—';
    }
    for (const id of ['secBestHash', 'secMedianHash', 'secWorstHash']) {
      $(id).textContent = '—';
    }
    $('secClock').textContent = 'Waiting for hashes';
  }

  renderAllTime();
  renderCurrentBlock();
  renderProgress();
}

function renderAllTime() {
  for (const [kind, record] of [['Best', state.best], ['Worst', state.worst]]) {
    const prefix = `all${kind}`;
    if (record) {
      $(`${prefix}Diff`).textContent = `Diff ${formatNumber(record.difficulty)}`;
      $(`${prefix}Hash`).textContent = record.hash;
      const lifetime = record.lifetimeHashes == null ? 'lifetime count unavailable' : `lifetime hash #${Number(record.lifetimeHashes).toLocaleString()}`;
      $(`${prefix}Meta`).textContent = `${new Date(record.at).toLocaleString()} · ${lifetime}`;
    } else {
      $(`${prefix}Diff`).textContent = '—';
      $(`${prefix}Hash`).textContent = '—';
      $(`${prefix}Meta`).textContent = 'No record yet.';
    }
  }
}

function renderCurrentBlock() {
  const block = state.currentBlock;
  $('blockHeight').textContent = block?.height == null ? 'Unknown' : Number(block.height).toLocaleString();
  const blockHashText = Number(block?.hashes || 0).toLocaleString();
  $('blockHashes').textContent = blockHashText;
  $('blockHashesMirror').textContent = blockHashText;
  $('blockBest').textContent = block?.best ? `Diff ${formatNumber(block.best.difficulty)}` : '—';
  $('blockTrackingAge').textContent = block?.startedAt ? formatFriendlyDuration(Date.now() - Number(block.startedAt)) : '—';
  $('blockTip').textContent = block?.tipHash ? `Tip ${shortHash(block.tipHash, 16)}` : 'Tip hash unavailable';
}

function outcomeText(record) {
  if (record.blockCandidate) return 'Block candidate';
  if (record.shareAccepted) return 'Accepted share';
  if (record.submitted) return 'Submitted';
  return 'Not submitted · local synthetic work';
}

function renderRecords() {
  const body = $('recordBody');
  const records = state.records.slice(-100).reverse();
  if (!records.length) {
    body.innerHTML = '<tr><td colspan="12">No record-breaking hashes yet.</td></tr>';
    return;
  }

  body.innerHTML = records.map((record) => {
    const previous = record.previousDifficulty == null ? 'First saved record' : `Diff ${formatNumber(record.previousDifficulty, 5)}<br><span class="sub">${escapeHtml(shortHash(record.previousHash))}</span>`;
    const improvement = record.improvementMultiplier == null ? '—' : `${formatNumber(record.improvementMultiplier, 5)}×`;
    const counts = `S ${formatCount(record.sessionHashes)}<br>L ${formatCount(record.lifetimeHashes)}<br>B ${formatCount(record.currentBlockHashes)}`;
    const job = `${escapeHtml(record.jobId || 'legacy/unknown')}<br><span class="sub">tip ${escapeHtml(shortHash(record.networkTipHash))}</span>`;
    const performance = `${formatStoredHashrate(record.hashrate)}<br><span class="sub">${formatDuration(record.runtimeMs)}</span>`;

    return `<tr>
      <td>${escapeHtml(record.timestamp || new Date(record.at).toISOString())}</td>
      <td>${escapeHtml(formatNumber(record.difficulty, 6))}</td>
      <td class="hash">${escapeHtml(record.hash)}</td>
      <td>${previous}</td>
      <td>${escapeHtml(improvement)}</td>
      <td>${escapeHtml(formatNumber(record.networkDifficulty, 6))}</td>
      <td>${escapeHtml(formatTargetPercentage(record.targetPercentage))}</td>
      <td>${counts}</td>
      <td>${job}</td>
      <td>${escapeHtml(outcomeText(record))}</td>
      <td>${performance}</td>
      <td>${record.meetsNetworkDifficulty ? 'Reference target met*' : 'No'}${record.nonce == null ? '' : `<br><span class="sub">nonce ${Number(record.nonce).toLocaleString()}</span>`}</td>
    </tr>`;
  }).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[character]);
}

function renderProgress() {
  const bestDifficulty = Number(state.best?.difficulty) || 0;
  const referenceShare = Math.max(Number($('shareTarget').value) || 1, 1e-18);
  const networkDifficulty = state.networkDifficulty;

  $('gapPool').textContent = bestDifficulty > 0 ? (bestDifficulty >= referenceShare ? 'Reference reached' : `${formatNumber(referenceShare / bestDifficulty)}× harder`) : '—';
  $('gapNetwork').textContent = bestDifficulty > 0 && networkDifficulty ? `${formatNumber(networkDifficulty / bestDifficulty)}× harder` : '—';
  $('targetPercent').textContent = bestDifficulty > 0 && networkDifficulty ? formatTargetPercentage((bestDifficulty / networkDifficulty) * 100) : '—';
  $('sinceBest').textContent = state.best ? formatFriendlyDuration(Date.now() - state.best.at) : '—';

  if (state.records.length >= 2) {
    const first = state.records[0].at;
    const last = state.records.at(-1).at;
    $('avgRecordTime').textContent = formatFriendlyDuration((last - first) / (state.records.length - 1));
  } else {
    $('avgRecordTime').textContent = '—';
  }
}
