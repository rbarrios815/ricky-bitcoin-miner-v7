'use strict';

const assert = require('node:assert/strict');
const { sha256, doubleSha256 } = require('../sha256.js');

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function bytesFromHex(value) {
  return new Uint8Array(Buffer.from(value, 'hex'));
}

function reverseHex(bytes) {
  return Buffer.from(bytes).reverse().toString('hex');
}

assert.equal(
  hex(sha256(new Uint8Array())),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'SHA-256 empty-string vector failed'
);

assert.equal(
  hex(sha256(new TextEncoder().encode('abc'))),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'SHA-256 abc vector failed'
);

assert.equal(
  hex(doubleSha256(new Uint8Array())),
  '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456',
  'SHA-256d empty-string vector failed'
);

const genesisHeader = bytesFromHex(
  '01000000' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a' +
  '29ab5f49' +
  'ffff001d' +
  '1dac2b7c'
);

assert.equal(genesisHeader.length, 80, 'Genesis header must be 80 bytes');
assert.equal(
  reverseHex(doubleSha256(genesisHeader)),
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  'Bitcoin genesis block header hash failed'
);

console.log('SHA-256/SHA-256d test vectors passed.');
