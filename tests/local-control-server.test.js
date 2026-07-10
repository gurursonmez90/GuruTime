const assert = require('node:assert/strict');
const test = require('node:test');

const { digest, timingSafeEqualString, MAX_BODY_BYTES, MAX_COMMANDS_PER_MINUTE } = require('../src/lib/local-control-server');

test('local control uses fixed-size hashes and timing-safe comparison', () => {
  assert.equal(digest('secret').length, 64);
  assert.equal(timingSafeEqualString(digest('a'), digest('a')), true);
  assert.equal(timingSafeEqualString(digest('a'), digest('b')), false);
});

test('local control limits payloads and commands', () => {
  assert.equal(MAX_BODY_BYTES, 4096);
  assert.equal(MAX_COMMANDS_PER_MINUTE, 20);
});
