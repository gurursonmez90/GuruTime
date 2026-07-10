import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoDowngrade,
  compareVersions,
  immutableKeys,
  versionsToPrune
} from '../../scripts/release/publish-r2.mjs';

test('R2 keys keep release binaries and manifests under immutable version paths', () => {
  assert.deepEqual(
    immutableKeys({ channel: 'beta', version: '3.0.0-beta.2', artifactName: 'GuruTime-3.0.0-beta.2-universal.dmg' }),
    {
      artifact: 'releases/beta/3.0.0-beta.2/GuruTime-3.0.0-beta.2-universal.dmg',
      manifest: 'releases/beta/3.0.0-beta.2/manifest.json',
      latest: 'releases/beta/latest.json'
    }
  );
});

test('retention keeps the five newest semantic versions per channel', () => {
  const versions = ['1.0.0', '1.1.0', '1.2.0', '2.0.0-beta.1', '2.0.0-beta.2', '2.0.0', 'garbage'];
  assert.deepEqual(versionsToPrune(versions, 5), ['1.0.0']);
  assert(compareVersions('2.0.0', '2.0.0-beta.9') > 0);
  assert(compareVersions('2.0.0-beta.10', '2.0.0-beta.2') > 0);
  assert.doesNotThrow(() => assertNoDowngrade('2.1.0', versions));
  assert.throws(() => assertNoDowngrade('1.9.0', ['2.0.0']), /channel rollback/);
});
