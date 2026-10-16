# Offline provisioning of the engine image

MeCode runs your code in a local Docker container from the image `mecode-engine:v2` (or the image named by `MECODE_ENGINE_IMAGE`). The application never downloads anything and never pulls an image. "Offline" therefore means: **after one explicit provisioning step, the app starts and runs without a network.**

Prerequisites (operator-installed, never installed by MeCode): Node.js 26.7.0, a running Docker Engine/Docker Desktop you are allowed to use, a browser.

## Option 1 - import a local engine export (no network needed)

An export is three files: `engine.tar`, `manifest.json` (image ID, OS/architecture, byte size, SHA-256, engine-recipe hash, exporting revision) and `SHA256SUMS`.

Export on a machine that already has the image (creates a NEW tag; the original tag is untouched):

```
node scripts/provision-engine.cjs export --image mecode-engine:v2 --alias mecode-engine:<name> --out <new-empty-dir>
```

Import on the target machine (verifies size and SHA-256 and the platform before `docker load`):

```
node scripts/provision-engine.cjs import --manifest <dir>/manifest.json
MECODE_ENGINE_IMAGE=mecode-engine:<name> ./start.sh        # then Retry in the page if it was already open
```

Refusals (nothing is loaded): checksum or size mismatch, OS/architecture different from the local Docker, an alias that already exists and points to a different image, an archive that would also tag another name, or whose image config (OS/architecture/variant) differs from the manifest, a symlink/special file as archive or manifest, the shared tag `mecode-engine:v2` as alias.

Limits you should know:

- The checksum is **integrity, not authentication**: it detects damage, not a malicious publisher. Import only bundles you trust.
- The archive is architecture-specific. A Linux amd64 export does not run on arm64 or Apple Silicon. Windows/macOS Docker paths are **untested** here.
- The engine recipe hash points at `engine/Dockerfile`, `adapters.py` and `runner.py`; it does not prove the image was built from them.
- Nothing is pushed, uploaded or published, and no image is deleted or pruned by these commands.

## Option 2 - build natively (needs network)

```
docker build -t mecode-engine:v2 engine/
```

The Dockerfile uses `apt-get`, so this is **online** provisioning unless every layer is already in your Docker cache. It is not an offline fallback.

## When the image is missing

The page shows backend `unavailable` with the reason `Engine image "<tag>" is not present locally`, and Run / Submit stay disabled. Import (or build), then press **Retry** or restart the app.

## What the repository proves (and does not)

`node scripts/verify-offline.cjs` (development checkout only) exports an existing local image under a task-owned alias, removes only that alias, starts a fresh extracted package with fresh data, observes the missing-image state, imports the verified export, and runs four real accepted submissions (Python, JavaScript, C++, C). It records browser requests outside loopback and that the engine container runs with `--network none`. This is scoped application evidence; it is **not** a whole-host network isolation or a security certification.
