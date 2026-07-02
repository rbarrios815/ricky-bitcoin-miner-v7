'use strict';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'rickyMinerV7State';
const DIFF1_PROB_DENOM = 4294967296;

const state = {
  running: false, paused: false, workers: [], totalHashes: 0, startedAt: null,
  elapsedBeforeStart: 0, rateWindow: [], buckets: new Map(),
  best: null, worst: null, records: [], chartPoints: [], networkDifficulty: null,
  lastRenderedSecond: null
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.best = saved.best || null;
    state.worst = saved.worst || null;
    state.records = Array.isArray(saved.records) ? saved.records.slice(-500) : [];
    state.chartPoints = Array.isArray(saved.chartPoints) ? saved.chartPoints.slice(-1000) : [];
  } catch (_) {}
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    best: state.best, worst: state.worst, records: state.records.slice(-500), chartPoints: state.chartPoints.slice(-1000)
  }));
}

function formatNumber(n, digits = 3) {
  if (n == null || Number.isNaN(n)) return '—';
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e12 || a < 1e-6) return n.toExponential(digits);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return n.toLocaleString(undefined, { maximumSignificantDigits: digits + 2 });
}

function formatHashrate(h) {
  const units = ['H/s','kH/s','MH/s','GH/s','TH/s'];
  let i = 0;
  while (h >= 1000 && i < units.length - 1) { h /= 1000; i++; }
  return `${h.toFixed(h >= 100 ? 0 : h >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h,m,sec].map(v => String(v).padStart(2,'0')).join(':');
}

function formatFriendlyDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return '<1 sec';
  const s = Math.floor(ms/1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);
  if (m < 60) return `${m}m ${s%60}s`;
  const h = Math.floor(m/60);
  return `${h}h ${m%60}m`;
}

function compareHash(a, b) { return a.localeCompare(b); }

function ensureBucket(second) {
  if (!state.buckets.has(second)) state.buckets.set(second, { second, count: 0, best: null, worst: null, segments: [], median: null, dirty: true });
  return state.buckets.get(second);
}

function aggregateBatch(msg) {
  const bucket = ensureBucket(msg.second);
  bucket.count += msg.count;
  bucket.segments.push(new Float64Array(msg.prefixes));
  bucket.dirty = true;
  if (!bucket.best || compareHash(msg.bestHash, bucket.best.hash) < 0) bucket.best = { hash: msg.bestHash, difficulty: msg.bestDifficulty };
  if (!bucket.worst || compareHash(msg.worstHash, bucket.worst.hash) > 0) bucket.worst = { hash: msg.worstHash, difficulty: msg.worstDifficulty };

  state.totalHashes += msg.count;
  const now = performance.now();
  state.rateWindow.push({ t: now, count: msg.count });
  while (state.rateWindow.length && now - state.rateWindow[0].t > 3000) state.rateWindow.shift();

  considerAllTime(msg.bestHash, msg.bestDifficulty, true);
  considerAllTime(msg.worstHash, msg.worstDifficulty, false);

  const cutoff = Math.floor(Date.now()/1000) - 3;
  for (const sec of state.buckets.keys()) if (sec < cutoff) state.buckets.delete(sec);
}

function considerAllTime(hash, difficulty, isBest) {
  if (isBest) {
    if (!state.best || compareHash(hash, state.best.hash) < 0) {
      const now = Date.now();
      state.best = { hash, difficulty, at: now, totalHashes: state.totalHashes };
      state.records.push({ hash, difficulty, at: now, totalHashes: state.totalHashes });
      state.records = state.records.slice(-500);
      state.chartPoints.push({ at: now, difficulty });
      state.chartPoints = state.chartPoints.slice(-1000);
      saveState();
      renderRecords(); drawChart();
    }
  } else if (!state.worst || compareHash(hash, state.worst.hash) > 0) {
    state.worst = { hash, difficulty, at: Date.now(), totalHashes: state.totalHashes };
    saveState();
  }
}

function computeMedian(bucket) {
  if (!bucket || !bucket.count) return null;
  if (!bucket.dirty && bucket.median != null) return bucket.median;
  const all = new Float64Array(bucket.count);
  let offset = 0;
  for (const seg of bucket.segments) { all.set(seg, offset); offset += seg.length; }
  all.sort();
  const mid = Math.floor(all.length / 2);
  bucket.median = all.length % 2 ? all[mid] : (all[mid - 1] + all[mid]) / 2;
  bucket.dirty = false;
  return bucket.median;
}

function medianPrefixText(value) {
  if (value == null) return { short: '—', hash: '—' };
  const aligned = BigInt(Math.floor(value)) << 3n;
  const prefix = aligned.toString(16).padStart(14, '0');
  const percentile = (value / Math.pow(2, 53)) * 100;
  return { short: `${percentile.toFixed(3)}%`, hash: `≈ ${prefix}… (53-bit ordered prefix)` };
}

function currentRate() {
  if (state.rateWindow.length < 2) return 0;
  const count = state.rateWindow.reduce((s,x) => s+x.count, 0);
  const span = Math.max(250, state.rateWindow[state.rateWindow.length-1].t - state.rateWindow[0].t);
  return count * 1000 / span;
}

function activeElapsed() {
  return state.elapsedBeforeStart + (state.running && !state.paused && state.startedAt ? Date.now() - state.startedAt : 0);
}

function render() {
  $('hashrate').textContent = formatHashrate(currentRate());
  $('totalHashes').textContent = state.totalHashes.toLocaleString();
  $('uptime').textContent = formatDuration(activeElapsed());

  const nowSec = Math.floor(Date.now()/1000);
  const bucket = state.buckets.get(nowSec) || state.buckets.get(nowSec - 1);
  if (bucket) {
    $('secondCount').textContent = bucket.count.toLocaleString();
    $('secBestDiff').textContent = `Diff ${formatNumber(bucket.best?.difficulty)}`;
    $('secBestHash').textContent = bucket.best?.hash || '—';
    const med = medianPrefixText(computeMedian(bucket));
    $('secMedianPrefix').textContent = med.short;
    $('secMedianHash').textContent = med.hash;
    $('secWorstDiff').textContent = `Diff ${formatNumber(bucket.worst?.difficulty)}`;
    $('secWorstHash').textContent = bucket.worst?.hash || '—';
    if (bucket.best && bucket.worst) {
      const bestPrefix = BigInt('0x' + bucket.best.hash.slice(0,16));
      const worstPrefix = BigInt('0x' + bucket.worst.hash.slice(0,16));
      const span = Number(worstPrefix - bestPrefix) / Number(0xffffffffffffffffn) * 100;
      $('secSpan').textContent = `${span.toFixed(3)}%`;
    } else $('secSpan').textContent = '—';
    $('secClock').textContent = `Bucket ${new Date(bucket.second*1000).toLocaleTimeString()} · ${bucket.count.toLocaleString()} hashes`;
  } else {
    ['secondCount'].forEach(id => $(id).textContent='0');
    ['secBestDiff','secMedianPrefix','secWorstDiff','secSpan'].forEach(id => $(id).textContent='—');
    ['secBestHash','secMedianHash','secWorstHash'].forEach(id => $(id).textContent='—');
    $('secClock').textContent='Waiting for hashes';
  }

  renderAllTime();
  renderProgress();
}

function renderAllTime() {
  if (state.best) {
    $('allBestDiff').textContent = `Diff ${formatNumber(state.best.difficulty)}`;
    $('allBestHash').textContent = state.best.hash;
    $('allBestMeta').textContent = `${new Date(state.best.at).toLocaleString()} · after ${Number(state.best.totalHashes||0).toLocaleString()} session hashes`;
  } else {
    $('allBestDiff').textContent='—'; $('allBestHash').textContent='—'; $('allBestMeta').textContent='No record yet.';
  }
  if (state.worst) {
    $('allWorstDiff').textContent = `Diff ${formatNumber(state.worst.difficulty)}`;
    $('allWorstHash').textContent = state.worst.hash;
    $('allWorstMeta').textContent = `${new Date(state.worst.at).toLocaleString()} · after ${Number(state.worst.totalHashes||0).toLocaleString()} session hashes`;
  } else {
    $('allWorstDiff').textContent='—'; $('allWorstHash').textContent='—'; $('allWorstMeta').textContent='No record yet.';
  }
}

function renderRecords() {
  const body = $('recordBody');
  const rows = state.records.slice(-100).reverse();
  if (!rows.length) { body.innerHTML='<tr><td colspan="4">No record-breaking hashes yet.</td></tr>'; return; }
  body.innerHTML = rows.map(r => `<tr><td>${escapeHtml(new Date(r.at).toLocaleString())}</td><td>${escapeHtml(formatNumber(r.difficulty,5))}</td><td class="hash">${escapeHtml(r.hash)}</td><td>${Number(r.totalHashes||0).toLocaleString()}</td></tr>`).join('');
}

function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

function renderProgress() {
  const bestDiff = state.best?.difficulty || 0;
  const pool = Math.max(Number($('shareTarget').value) || 1, 1e-18);
  const network = state.networkDifficulty;
  $('gapPool').textContent = bestDiff > 0 ? (bestDiff >= pool ? 'Target reached' : `${formatNumber(pool / bestDiff)}× harder`) : '—';
  $('gapNetwork').textContent = bestDiff > 0 && network ? `${formatNumber(network / bestDiff)}× harder` : '—';
  $('sinceBest').textContent = state.best ? formatFriendlyDuration(Date.now() - state.best.at) : '—';
  if (state.records.length >= 2) {
    const first = state.records[0].at, last = state.records[state.records.length-1].at;
    $('avgRecordTime').textContent = formatFriendlyDuration((last-first)/(state.records.length-1));
  } else $('avgRecordTime').textContent='—';
}

function startWorkers() {
  stopWorkers();
  state.running = true; state.paused = false; state.startedAt = Date.now(); state.rateWindow = [];
  const count = Number($('workerCount').value);
  const batch = Number($('batchSize').value);
  for (let i=0;i<count;i++) {
    const w = new Worker('miner-worker.js');
    w.onmessage = (e) => { if (e.data?.type === 'batch') aggregateBatch(e.data); };
    w.onerror = (e) => { console.error(e); $('statusText').textContent='Worker error'; };
    const seed = new Uint8Array(80); crypto.getRandomValues(seed);
    w.postMessage({type:'start',workerId:i,batchSize:batch,seed:seed.buffer},[seed.buffer]);
    state.workers.push(w);
  }
  updateControls();
}

function pauseResume() {
  if (!state.running) return;
  if (!state.paused) {
    state.elapsedBeforeStart += Date.now() - state.startedAt;
    state.startedAt = null; state.paused = true;
    state.workers.forEach(w => w.postMessage({type:'pause'}));
  } else {
    state.startedAt = Date.now(); state.paused = false;
    state.workers.forEach(w => w.postMessage({type:'resume'}));
  }
  updateControls();
}

function stopWorkers() {
  state.workers.forEach(w => { try { w.postMessage({type:'stop'}); w.terminate(); } catch(_){} });
  state.workers=[];
}

function resetSession() {
  if (state.running && !state.paused && state.startedAt) state.elapsedBeforeStart += Date.now()-state.startedAt;
  stopWorkers();
  state.running=false; state.paused=false; state.totalHashes=0; state.startedAt=null; state.elapsedBeforeStart=0;
  state.rateWindow=[]; state.buckets.clear();
  updateControls(); render();
}

function updateControls() {
  $('startBtn').disabled = state.running;
  $('pauseBtn').disabled = !state.running;
  $('pauseBtn').textContent = state.paused ? 'Resume' : 'Pause';
  $('workerCount').disabled = state.running;
  $('statusDot').classList.toggle('running', state.running && !state.paused);
  $('statusText').textContent = !state.running ? 'Stopped' : state.paused ? 'Paused' : 'Hashing';
}

function exportCsv() {
  const rows = [['timestamp','difficulty','hash','session_hashes']];
  for (const r of state.records) rows.push([new Date(r.at).toISOString(),r.difficulty,r.hash,r.totalHashes||0]);
  const csv = rows.map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv'}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download='ricky-miner-v7-record-hashes.csv'; a.click(); URL.revokeObjectURL(url);
}

async function loadNetwork() {
  try {
    const r = await fetch('/api/network', {cache:'no-store'});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.networkDifficulty = Number(data.difficulty) || null;
    const h = Number(data.networkHashrate) || null;
    $('networkStatus').textContent = state.networkDifficulty ? `Bitcoin difficulty ${formatNumber(state.networkDifficulty)}${h ? ` · estimated ${formatHashrate(h)}` : ''}` : 'Network target unavailable';
  } catch (e) {
    $('networkStatus').textContent = 'Network difficulty unavailable; local hashing still works.';
  }
  drawChart(); renderProgress();
}

function drawChart() {
  const c=$('chart'), ctx=c.getContext('2d');
  const rect=c.getBoundingClientRect(), dpr=Math.max(1,window.devicePixelRatio||1);
  const w=Math.max(600,Math.floor(rect.width*dpr)), h=Math.max(260,Math.floor(rect.height*dpr));
  if(c.width!==w||c.height!==h){c.width=w;c.height=h}
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#071624';ctx.fillRect(0,0,w,h);
  const pad={l:70*dpr,r:22*dpr,t:22*dpr,b:40*dpr};
  const points=state.chartPoints.slice(-300);
  const pool=Math.max(Number($('shareTarget').value)||1,1e-18), network=state.networkDifficulty;
  const vals=points.map(p=>Math.max(p.difficulty,1e-18)).concat([pool]).concat(network?[network]:[]);
  let minLog=Math.floor(Math.min(...vals.map(Math.log10),-18)); let maxLog=Math.ceil(Math.max(...vals.map(Math.log10),0));
  if(maxLog-minLog<4){maxLog+=2;minLog-=2}
  const x=(i)=>pad.l+(points.length<=1?0.5:(i/(points.length-1)))*(w-pad.l-pad.r);
  const y=(v)=>pad.t+(maxLog-Math.log10(Math.max(v,1e-18)))/(maxLog-minLog)*(h-pad.t-pad.b);
  ctx.strokeStyle='#1f3b54';ctx.lineWidth=1*dpr;ctx.fillStyle='#8fa8bd';ctx.font=`${11*dpr}px system-ui`;
  for(let p=minLog;p<=maxLog;p+=Math.max(1,Math.ceil((maxLog-minLog)/8))){const yy=y(Math.pow(10,p));ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();ctx.fillText(`1e${p}`,8*dpr,yy+4*dpr)}
  function targetLine(v,color,label){if(!v)return;const yy=y(v);ctx.strokeStyle=color;ctx.setLineDash([7*dpr,5*dpr]);ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.fillText(label,pad.l+6*dpr,Math.max(14*dpr,yy-5*dpr))}
  targetLine(pool,'#ffb72b','Pool/share target'); targetLine(network,'#ff5d73','Bitcoin network target');
  if(points.length){ctx.strokeStyle='#3da5ff';ctx.lineWidth=2*dpr;ctx.beginPath();points.forEach((p,i)=>{const xx=x(i),yy=y(p.difficulty);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.stroke();ctx.fillStyle='#3da5ff';points.forEach((p,i)=>{ctx.beginPath();ctx.arc(x(i),y(p.difficulty),2.2*dpr,0,Math.PI*2);ctx.fill()})}
  else{ctx.fillStyle='#91a7bd';ctx.font=`${15*dpr}px system-ui`;ctx.fillText('Start hashing to build the record-progress chart.',pad.l,h/2)}
  ctx.fillStyle='#8fa8bd';ctx.font=`${11*dpr}px system-ui`;ctx.fillText('Record sequence →',w-120*dpr,h-12*dpr);
}

function initWorkerOptions() {
  const max=Math.max(1,Math.min(8,(navigator.hardwareConcurrency||4)-1));
  for(let i=1;i<=max;i++){const o=document.createElement('option');o.value=i;o.textContent=i;if(i===Math.min(2,max))o.selected=true;$('workerCount').appendChild(o)}
}

$('startBtn').addEventListener('click',startWorkers);
$('pauseBtn').addEventListener('click',pauseResume);
$('resetBtn').addEventListener('click',resetSession);
$('batchSize').addEventListener('change',()=>state.workers.forEach(w=>w.postMessage({type:'batch-size',batchSize:Number($('batchSize').value)})));
$('shareTarget').addEventListener('input',()=>{renderProgress();drawChart()});
$('exportBtn').addEventListener('click',exportCsv);
$('clearRecordsBtn').addEventListener('click',()=>{if(confirm('Clear all saved best/worst hashes and record history for v7?')){state.best=null;state.worst=null;state.records=[];state.chartPoints=[];saveState();renderAllTime();renderRecords();drawChart();renderProgress()}});
window.addEventListener('resize',drawChart);
window.addEventListener('beforeunload',stopWorkers);

initWorkerOptions();loadState();renderRecords();renderAllTime();updateControls();drawChart();loadNetwork();
setInterval(render,250);setInterval(loadNetwork,10*60*1000);
