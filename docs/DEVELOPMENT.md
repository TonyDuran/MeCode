# MeCode V2 — development, packs, install (vertical slice T02)

## Layout

- `src/web/server.cjs` loopback-only HTTP server (shipped runtime). `src/renderer/bridge.js` browser side of `window.mecode`. `src/main/services.cjs` transport-independent handlers (used by web AND the optional Electron wrapper `src/main.cjs` + `src/preload.cjs`). `src/renderer/` plain DOM UI (text-only rendering).
- `src/main/*` catalog, store, judge, backend (docker lifecycle), exec (job manager). `src/shared/validate.cjs` pack schema.
- `engine/` runner.py + adapters.py + Dockerfile (python3, node, g++/gcc; adapters: python, javascript, cpp, c).
- `packs/core.json` seeded into the managed pack dir on first launch only; user edits are never overwritten.

## Checks

    node --test "tests/unit/*.test.cjs"            # unit + fake-engine protocol + HOST-run runner.py
    MECODE_REAL_DOCKER=1 node --test --test-concurrency=1 tests/integration/docker.test.cjs   # real containers; needs the image

Without `MECODE_REAL_DOCKER=1` the integration tests are SKIPPED (not run, not passed). Settings (execution limits) are applied to the next container only after being persisted; they are rejected while a job runs.

## Provision the engine (once, needs a network you are authorized to use; the app never downloads)

    docker build -t mecode-engine:v2 engine/     # base python:3.14-slim pinned by digest in engine/Dockerfile
    docker save mecode-engine:v2 | gzip > mecode-engine-v2.tar.gz     # offline copy
    docker load < mecode-engine-v2.tar.gz                             # on another machine

Docker (rootless OK) is a prerequisite. The app only checks it, starts its OWN container (`--network none`, read-only, cap-drop ALL, no-new-privileges, memory/pids/cpu limits, no mounts) and shows Retry if unavailable.

## Package / start (local web; see README.md)

    node scripts/package-web.cjs      # -> dist/mecode-v2-web-<rev>.tar.gz (+ .sha256, MANIFEST.json with source revision/tree/file hashes)
    node src/web/server.cjs           # prints the launch link

Env: `MECODE_USER_DATA` (data dir), `MECODE_ENGINE_IMAGE`, `MECODE_PORT`, `MECODE_LAUNCH_FILE`. The old Electron packager `scripts/package.cjs` is kept but the Electron build cannot launch on the QA host (native sandbox helper); it is not the shipped runtime.
Electron-only note: Chromium needs a setuid chrome-sandbox or permitted unprivileged user namespaces; the app never passes --no-sandbox.

## Packs

One UTF-8 JSON file ≤5 MiB, schema v1 (see T01 handoff). Import via the UI file picker, or edit files in `<userData>/packs/` and press **Reload packs**. Invalid import/reload keeps the last-good catalog and shows file/path/message errors. Tests of kind `check` are kept host-side; only examples are shown in the UI. Editing any test changes the problem `contentHash`; acceptance for an older hash shows as `stale`, not solved.
