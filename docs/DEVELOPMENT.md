# MeCode V2 — development, packs, install (vertical slice T02)

## Layout
- `src/main.cjs` Electron main (supervisor, IPC). `src/preload.cjs` narrow `window.mecode` bridge. `src/renderer/` plain DOM UI (text-only rendering).
- `src/main/*` catalog, store, judge, backend (docker lifecycle), exec (job manager). `src/shared/validate.cjs` pack schema.
- `engine/` runner.py + adapters.py + Dockerfile (python3, node, g++/gcc; adapters: python, javascript, cpp, c).
- `packs/core.json` seeded into the managed pack dir on first launch only; user edits are never overwritten.

## Checks
    node --test "tests/unit/*.test.cjs"            # unit + fake-engine protocol + HOST-run runner.py
    MECODE_REAL_DOCKER=1 node --test tests/integration/docker.test.cjs   # real container; needs provisioned image
Without `MECODE_REAL_DOCKER=1` the integration tests are SKIPPED (not run, not passed).

## Provision the engine (once, needs a network you are authorized to use — the app never downloads)
    docker build -t mecode-engine:v2 engine/
    docker save mecode-engine:v2 | gzip > mecode-engine-v2.tar.gz     # offline copy
    docker load < mecode-engine-v2.tar.gz                             # on another machine
Docker (rootless OK) is a prerequisite. The app only checks it, starts its OWN container (`--network none`, read-only, cap-drop ALL, no-new-privileges, memory/pids/cpu limits, no mounts) and shows Retry if unavailable.

## Package / start (Linux x64, cached Electron 44.7.2, no network)
    node scripts/package.cjs          # -> dist/mecode-v2-linux-x64{/,.tar.gz}
    dist/mecode-v2-linux-x64/mecode-v2
Env: `MECODE_USER_DATA` overrides the data dir (default `~/.config/MeCode-V2`), `MECODE_ENGINE_IMAGE` overrides the image tag.
Known host requirement: Electron's Chromium sandbox needs either a setuid `chrome-sandbox` (root-owned, 4755) or unprivileged user namespaces permitted by the OS (Ubuntu: AppArmor `apparmor_restrict_unprivileged_userns`). The app never passes `--no-sandbox`.

## Packs
One UTF-8 JSON file ≤5 MiB, schema v1 (see T01 handoff). Import via the UI file picker, or edit files in `<userData>/packs/` and press **Reload packs**. Invalid import/reload keeps the last-good catalog and shows file/path/message errors. Tests of kind `check` are kept host-side; only examples are shown in the UI. Editing any test changes the problem `contentHash`; acceptance for an older hash shows as `stale`, not solved.
