import assert from 'node:assert/strict';
import test from 'node:test';
import { assertUniversalArchitectures } from '../../scripts/release/verify-artifact.mjs';

test('requires exactly arm64 and x86_64 slices', () => {
  assert.doesNotThrow(() => assertUniversalArchitectures('x86_64 arm64\n'));
  assert.throws(() => assertUniversalArchitectures('arm64\n'), /x86_64/);
  assert.throws(() => assertUniversalArchitectures('x86_64 arm64 ppc\n'), /expected/);
});
