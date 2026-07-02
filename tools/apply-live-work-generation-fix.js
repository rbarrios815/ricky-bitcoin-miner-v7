'use strict';

const fs = require('fs');

function replaceOnce(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(oldText, newText);
}

let server = fs.readFileSync('server.js', 'utf8');
server = replaceOnce(server,
`  miner.on('job', job => {
    resetHashEvidence();
    state.jobId = job.jobId;
    state.jobReceivedAt = Date.now();
    state.generation = job.generation;
    state.currentWork = job;
    state.networkTarget = job.networkTargetHex;
    const nbitsDifficulty = Number(job.networkDifficulty);
    if (Number.isFinite(nbitsDifficulty) && nbitsDifficulty > 0) state.networkDifficulty = nbitsDifficulty;
    ensureBlockScope(job);
    addLog('stratum', \`Live job \${job.jobId} generation \${job.generation} received.\`);
    broadcastState();
  });
  miner.on('difficulty', difficulty => {`,
`  miner.on('job', job => {
    resetHashEvidence();
    state.jobId = job.jobId;
    state.jobReceivedAt = Date.now();
    state.generation = null;
    state.currentWork = null;
    state.networkTarget = job.networkTargetHex;
    const nbitsDifficulty = Number(job.networkDifficulty);
    if (Number.isFinite(nbitsDifficulty) && nbitsDifficulty > 0) state.networkDifficulty = nbitsDifficulty;
    ensureBlockScope(job);
    addLog('stratum', \`Live pool job \${job.jobId} received; constructing hash work.\`);
    broadcastState();
  });
  miner.on('work', work => {
    resetHashEvidence();
    state.jobId = work.jobId;
    state.generation = work.generation;
    state.currentWork = work;
    state.networkTarget = work.networkTarget;
    const workDifficulty = Number(work.networkDifficulty);
    if (Number.isFinite(workDifficulty) && workDifficulty > 0) state.networkDifficulty = workDifficulty;
    const poolDifficulty = Number(work.poolDifficulty);
    if (Number.isFinite(poolDifficulty) && poolDifficulty > 0) state.poolDifficulty = poolDifficulty;
    addLog('stratum', \`Live work \${work.jobId} generation \${work.generation} ready for hashing.\`);
    broadcastState();
  });
  miner.on('difficulty', difficulty => {`,
'server job/work listener');
fs.writeFileSync('server.js', server);

let bridge = fs.readFileSync('tests/event_bridge.test.js', 'utf8');
bridge = replaceOnce(bridge,
`  const job = waitFor(miner, 'job', value => value.jobId === 'bridge-job' && Boolean(value.networkTargetHex));
  const ready = waitFor(miner, 'submission-ready', value => value === true);
  const batch = waitFor(miner, 'hash-batch', value => value.jobId === 'bridge-job');`,
`  const job = waitFor(miner, 'job', value => value.jobId === 'bridge-job' && Boolean(value.networkTargetHex));
  const work = waitFor(miner, 'work', value => value.jobId === 'bridge-job' && Number.isInteger(value.generation));
  const ready = waitFor(miner, 'submission-ready', value => value === true);
  const batch = waitFor(miner, 'hash-batch', value => value.jobId === 'bridge-job');`,
'event bridge work listener');
bridge = replaceOnce(bridge,
`  const values = await Promise.all([connected, subscribed, authorized, difficulty, job, ready, batch, hashrate, submitted, result]);
  const bridgeBatch = values[6];
  const bridgeSubmission = values[8];
  const bridgeResult = values[9];`,
`  const values = await Promise.all([connected, subscribed, authorized, difficulty, job, work, ready, batch, hashrate, submitted, result]);
  const bridgeWork = values[5];
  const bridgeBatch = values[7];
  const bridgeSubmission = values[9];
  const bridgeResult = values[10];`,
'event bridge result indexes');
bridge = replaceOnce(bridge,
`  assert.strictEqual(bridgeBatch.count, 16);`,
`  assert.strictEqual(bridgeWork.generation, bridgeBatch.generation);
  assert.strictEqual(bridgeWork.jobId, bridgeBatch.jobId);
  assert.strictEqual(bridgeBatch.count, 16);`,
'event bridge generation assertions');
fs.writeFileSync('tests/event_bridge.test.js', bridge);

let tests = fs.readFileSync('tests.js', 'utf8');
tests = replaceOnce(tests,
`  assert.ok(appSource.includes('result.state || await requestJson'));`,
`  assert.ok(appSource.includes('result.state || await requestJson'));
  const serverSource = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  assert.ok(serverSource.includes("miner.on('work', work => {"));
  assert.ok(serverSource.includes('state.generation = work.generation'));
  assert.ok(!serverSource.includes('state.generation = job.generation'));`,
'tests.js source assertions');
fs.writeFileSync('tests.js', tests);

console.log('Applied live-work generation repair.');
