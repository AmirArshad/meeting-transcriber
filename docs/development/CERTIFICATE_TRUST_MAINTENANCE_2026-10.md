# Certificate trust maintenance — October 2026

## Scope

Release 2.10.2 addresses the [eMudhra intermediate CA compromise](https://emudhra.we-have-a-problem.com/)
announced on 2026-10-20. The starting commit is `ea7381f` (v2.10.1 publication
record). No cloud processing, uploads, telemetry, capture format or inference
engine changes are included.

## Dependencies and compatibility

| Surface | Previous | Release target |
| --- | --- | --- |
| Electron | 44.7.0 | 44.9.2 |
| Packaged certifi, all three platforms | 2026.7.22 | 2026.10.19 |
| macOS Parakeet certifi | 2026.7.22 | 2026.10.19 |
| Bootstrap/bundled pip | 26.2.1 or standalone Python's pip | 26.2.2 |
| rustls-webpki | 0.103.14 | 0.103.16 |
| webpki-roots / webpki-root-certs | 1.0.9 | 1.0.10 |

Electron stays on major 44 and the existing desktop/IPC APIs. Its
[upstream blocklist change](https://github.com/electron/electron/commit/e02265be96c5e13ae43644ef482b718e1e800499)
applies compiled SPKI revocations to Chromium and Node TLS, including main-process
HTTPS. An affected root can remain in `tls.rootCertificates` while compromised
intermediate keys are blocked; enumerating roots is not a handshake test.

Development requirement files also set certifi >=2026.10.19.

certifi 2026.10.19 supports Python >=3.7, pip 26.2.2 supports Python >=3.10, and
rustls-webpki/webpki roots updates require Rust >=1.71. These fit the project's
Python 3.11 and Rust 1.88 baselines. Cargo resolution changes only the three
targeted trust packages and references to the updated root bundle.

RustSec RUSTSEC-2026-0381 also flags the certificate-free webpki-roots 0.26.11
compatibility facade by version. Its source only re-exports `parent::TLS_SERVER_ROOTS`,
and the lock resolves that parent to patched 1.0.10. ureq 2.12.1 through the
ocipkg/intel-mkl-src build chain requires the facade. A dated exception in
`native/speakrs-cli/.cargo/audit.toml` is guarded by
`tests/js/certificate-trust-dependencies.test.js`, which rejects stale roots,
root-certs, validators or a stale facade parent. Review by 2026-11-20. This
exception does not retain compromised root data; the three existing zip
extraction exceptions from v2.10.1 remain separately documented.

`ensurePipInstalled` previously returned when *any* pip worked. It now replaces
pip and stale pip dist-info from a SHA-256-verified wheel before installing other
packages on every platform. Existing build-resource manifest inputs include the
changed download manifest and requirement files, invalidating prepared resources.

The macOS Parakeet lock is regenerated with
`node scripts/update-parakeet-lock-wheel.js --lock macos-metal --package certifi --version 2026.10.19`.
This checks real wheel bytes, target compatibility and dependency requirements,
updates the complete extracted-file inventory, and recomputes the runtime digest.
Linux/Windows Parakeet locks do not contain certifi. Pyannote's explicit certifi
requirement changes its dependency marker so existing installations require setup.

hf-xet 1.7.0 remains the latest published package at preparation time and has an
independent native TLS stack. Ordinary and isolated Python children plus the
separate summary downloader enforce `HF_HUB_DISABLE_XET=1` after caller overrides.
Hugging Face's standard HTTP download path remains available; no certificate
checks are disabled. Re-enable Xet only after upstream trust handling and packaged
downloads are qualified. Preserve its dependency pin to retain a closed Hub
dependency set.

## Evidence collected in the cloud workspace

- Real certifi 2026.10.19 and pip 26.2.2 wheel bytes match the PyPI SHA-256 digests.
- Offline OpenSSL checks against all 12 chains from the incident's `chains.zip`:
  patched certifi and pip's vendored certifi each accept **0/12**. Old certifi
  2026.7.22 accepts **6/12**, providing a positive control. Verification uses an
  explicit CA file with default CA directory/store disabled; no network proxy
  certificate can substitute for the supplied chain.
- `npm run test:all`: **1,130 JS passed / 2 skipped**, **848 Python passed /
  8 skipped**, plus JS/Python syntax checks. The Electron UI regression ran on
  a temporary Xvfb display. A temporary subreaper supplied the process-reaping
  behavior missing from this container's PID 1; the initial process-kill test
  failure was a confirmed zombie, not a surviving CLI.
- `cargo test --locked`: **7 passed**, using Rust 1.88.0 and the updated lock.
- `cargo fmt --check` and `cargo clippy --locked -- -D warnings`: passed.
- `cargo audit --deny warnings`: passed with the documented facade exception
  and the three existing zip extraction exceptions.
- Real pip wheel bootstrap into a fresh temporary site-packages imports pip
  26.2.2 and its vendored certifi successfully.
- Hub 1.33.0 with hf-xet 1.7.0 installed and Xet disabled downloaded the real
  `hf-internal-testing/tiny-random-bert/model.safetensors` artifact (520,212 bytes)
  through HTTP with certifi 2026.10.19. Native Xet download calls were replaced
  with a failing sentinel to detect accidental use.
- `npm audit`: **0 vulnerabilities**.
- `pip-audit`: **0 findings** for each of the three base build inventories and
  each Parakeet lock/bootstrap pip inventory. Windows/macOS base inventories are
  audited as exact pins from Linux, not installed as native platform environments.
- Linux build dependency closure resolves exactly. Windows cross-host closure
  also resolves. macOS cross-host resolution on Linux cannot validate native
  markers: Torch's Linux-only CUDA dependencies have no matching macOS wheel.
  The existing native macOS CI closure gate remains required.

## Release tracking and gates

[PR #134](https://github.com/AmirArshad/meeting-transcriber/pull/134) tracks
the release branch and its native CI checks. The annotated `v2.10.2` tag is to
be created on the merged revision only after those checks pass. Installer
publication is tracked by the
[release workflow](https://github.com/AmirArshad/meeting-transcriber/actions/workflows/build-release.yml)
and [v2.10.2 release](https://github.com/AmirArshad/meeting-transcriber/releases/tag/v2.10.2).
No native Windows/macOS installer or new audio/GPU hardware qualification is
claimed from this Linux cloud environment. Do not merge or tag until all required
CI checks pass on the final revision.
