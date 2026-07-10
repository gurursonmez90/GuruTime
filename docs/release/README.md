# GuruTime macOS public release

This release path produces one `arm64 + x86_64` universal DMG. The app is signed with a Developer ID Application certificate, built with hardened runtime, notarized, stapled, checked by Gatekeeper, scanned for packaged secrets, and described by an Ed25519-signed update manifest.

Production releases use `build/electron-builder.public.yml`. The older development build settings in `package.json` must not be used for public artifacts.

## One-time setup

Install the current Xcode command-line tools, an Apple Developer ID Application certificate, Node dependencies, and AWS CLI v2. Configure a permanent custom domain such as `https://downloads.example.com` on the R2 bucket. `r2.dev` and `workers.dev` origins are intentionally rejected.

Store notarization credentials in Keychain so the app-specific password is not placed in a shell history or CI log:

```sh
xcrun notarytool store-credentials "gurutime-notary" \
  --apple-id "APPLE_ID" \
  --team-id "APPLE_TEAM_ID" \
  --password "APP_SPECIFIC_PASSWORD"
```

Generate the update signing key outside the repository and keep it independent from the Apple signing certificate:

```sh
mkdir -p "$HOME/.config/gurutime/release"
openssl genpkey -algorithm ed25519 \
  -out "$HOME/.config/gurutime/release/update-private.pem"
chmod 600 "$HOME/.config/gurutime/release/update-private.pem"
openssl pkey -in "$HOME/.config/gurutime/release/update-private.pem" \
  -pubout -out "$HOME/.config/gurutime/release/update-public.pem"
npm run release:pin-key -- "$HOME/.config/gurutime/release/update-public.pem"
```

The pin command writes only the public key to `src/update-public-key.pem`; the public build fails closed if it is absent or does not match the external signing private key. A manifest signature is useful only when the app verifies the canonical `payload` bytes with this pinned public key. Do not download the trusted public key from the same R2 location as the update.

## Environment

Required for every real release:

```sh
export CSC_NAME="Developer ID Application: Legal Name (TEAMID)"
export GURUTIME_NOTARY_PROFILE="gurutime-notary"
export GURUTIME_UPDATE_SIGNING_KEY_FILE="$HOME/.config/gurutime/release/update-private.pem"
export GURUTIME_DOWNLOADS_ORIGIN="https://downloads.example.com"
```

`GURUTIME_NOTARY_PROFILE` is preferred. The scripts also accept either of these complete credential sets:

- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, and `APPLE_API_KEY_FILE`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`

R2 publication additionally requires:

```sh
export R2_ACCOUNT_ID="cloudflare-account-id"
export R2_BUCKET="gurutime-downloads"
export AWS_ACCESS_KEY_ID="r2-access-key-id"
export AWS_SECRET_ACCESS_KEY="r2-secret-access-key"
```

Use an R2 token limited to object read/write on this bucket. The AWS values are inherited by the child process and are never included in command arguments or output.

## Commands

Run a safe static rehearsal first. It neither signs nor uploads:

```sh
node scripts/release/release.mjs --channel beta --dry-run
```

Build and validate a notarized beta without publishing:

```sh
node scripts/release/release.mjs --channel beta
```

Build, validate, and publish:

```sh
node scripts/release/release.mjs --channel beta --publish
node scripts/release/release.mjs --channel stable --publish
```

Stable releases reject prerelease versions. Update `package.json` to the exact release version before running the pipeline. The output is written under `dist/public/`.

Individual validation commands are also available:

```sh
node scripts/release/preflight.mjs
node scripts/release/verify-artifact.mjs dist/public/GuruTime-VERSION-universal.dmg
node scripts/release/scan-secrets.mjs dist/public/GuruTime-VERSION-universal.dmg
node --test tests/release/*.test.mjs
```

## R2 layout and retention

DMGs and signed manifests are written once to versioned immutable keys:

```text
releases/stable/2.1.0/GuruTime-2.1.0-universal.dmg
releases/stable/2.1.0/manifest.json
releases/stable/latest.json
releases/beta/2.2.0-beta.1/GuruTime-2.2.0-beta.1-universal.dmg
releases/beta/2.2.0-beta.1/manifest.json
releases/beta/latest.json
```

Versioned objects receive `Cache-Control: public,max-age=31536000,immutable`. The signed `latest.json` channel pointer receives `Cache-Control: no-store,max-age=0`. Publication refuses to overwrite an existing versioned key. After a successful upload, the oldest channel versions are removed until five remain. Stable and beta retention are independent.

## Secret scan

The artifact scan mounts the DMG, extracts `app.asar`, and checks packaged content. It blocks the retired `199064` password, private keys, common live tokens, credential literals, and long-lived URL tokens. Provide exact CI-held values without putting them on a command line:

```sh
export GURUTIME_SECRET_SCAN_VALUES='["value-from-ci-secret-store"]'
```

Findings report only a rule and file path, never the matching value. A narrowly scoped false positive can be documented in `build/secret-scan-allowlist.json`; global rule exemptions should not be used.

## Release acceptance

Before announcing a channel update, confirm all of the following:

1. `verify-artifact.mjs` confirms both CPU slices, Developer ID authority, hardened runtime, staple, Gatekeeper acceptance, and a clean secret scan.
2. `manifest.json` and `latest.json` share the intended version, channel, timestamp, and key ID.
3. The desktop app accepts the manifest with its pinned key and rejects a one-byte-modified manifest or DMG.
4. Both Intel and Apple Silicon smoke tests cover launch, menu bar, alarm sound, notification actions, sleep/wake, and update download.
5. A beta is promoted by building a new stable version. Existing immutable objects are never replaced.

## Package integration

The root package should expose these commands:

```json
{
  "scripts": {
    "test:release": "node --test tests/release/*.test.mjs",
    "release:dry": "node scripts/release/release.mjs --channel beta --dry-run",
    "release:beta": "node scripts/release/release.mjs --channel beta",
    "release:stable": "node scripts/release/release.mjs --channel stable",
    "release:verify": "node scripts/release/verify-artifact.mjs"
  }
}
```

No extra runtime dependency is required. Public build commands must pass `--config build/electron-builder.public.yml`; that config supplies the universal target, hardened runtime, entitlements, and notarization hooks.
