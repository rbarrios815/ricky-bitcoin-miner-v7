'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const helpers = require('../public/dashboard-enhancements.js');

assert.strictEqual(helpers.minuteKey(120), 2);
assert.strictEqual(helpers.minuteKey(179), 2);
const result = helpers.probabilityFromHashes(4294967296, 1);
assert.ok(Math.abs(result.expected - 1) < 0.000000000001);
assert.ok(result.probability > 0.63 && result.probability < 0.64);
assert.match(helpers.formatCentralDateTime('2026-07-02T18:00:00.000Z'), /CDT/);
assert.match(helpers.formatCentralDateTime('2026-01-02T18:00:00.000Z'), /CST/);

const source = fs.readFileSync(path.join(__dirname, '../public/dashboard-enhancements.js'), 'utf8');
assert.match(source, /if \(cell\.textContent !== formatted\) cell\.textContent = formatted;/);
assert.match(source, /observe\(recordBody, \{ childList: true, subtree: true \}\)/);
assert.doesNotMatch(source, /observe\(document\.body/);
assert.match(source, /refreshInFlight/);

console.log('Dashboard enhancement tests passed.');
