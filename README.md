# MeCode V2

A local, offline-after-setup coding-practice app. Browse problems, read statements/examples/constraints, pick a language, edit code, run the examples or your own input, submit against the full hidden test set, and keep your drafts and progress on your own machine. Your code runs inside an app-owned, locked-down container, never directly on your host.

Status: vertical slice (3 bundled problems, Python / JavaScript / C++17 / C17). Not a finished platform: the large pattern catalog and offline image provisioning are still to come (see "Status" below).

## How it works

- **Local web app** (`node src/web/server.cjs`): a small Node server bound to `127.0.0.1` only, serving a plain-DOM UI. No frameworks, no CDN, no remote assets, zero npm dependencies.
- **Containerised execution**: the app starts its own container from the `mecode-engine:v2` image (no network, read-only root, all capabilities dropped, memory/PID/CPU limits, unprivileged user). The server checks Docker health, prepares a container, waits until the engine reports ready (and its cgroup limits match what was requested), and only then enables **Run**. One fresh container per job, removed afterwards.
- **Problem packs**: JSON files you can write or edit yourself. Import one from the UI (file picker) or drop it in the managed packs folder and press **Reload packs**. Invalid packs are rejected with file/path messages and the previous good catalog stays in use. Editing a test changes the problem's content hash; earlier acceptances then show as `stale`.
- **Honest verdicts**: ACCEPTED only when every stored test passes on the current content hash; examples-only runs report EXAMPLES_PASSED; compile error, runtime error, time/output/memory limit and infrastructure failures are distinguished and never counted as solved.
- **Optional Electron wrapper** (`src/main.cjs`): same services behind IPC. It could not be launched on the QA host (native sandbox helper restriction), so it is untested and not the shipped path.

## Requirements

- Linux/macOS/Windows with Node.js 26.7.0 (the only validated version; older versions are unverified) and a browser.
- Docker (rootless is fine) running, and the engine image built once (needs a network you are allowed to use; the app never pulls or downloads on its own).

## Install and start

    # 1. build the engine image once (Debian trixie + Python 3.14, Node 20, g++/gcc 14)
    docker build -t mecode-engine:v2 engine/

    # 2. start the server
    node src/web/server.cjs

The server prints its **launch link**, for example `http://127.0.0.1:41234/#s=<secret>`. Open that exact link in your browser. The secret in the `#` fragment is a per-launch session capability: it is moved into the tab's session storage and removed from the address bar. Do not share the link. If you lose it, restart the server (the secret rotates on every start).

Closing the browser tab does **not** stop the server. Stop it with **Quit server** in the UI, or Ctrl-C / SIGTERM in the terminal; both stop the backend and remove the app-owned container before exiting. One server per data folder (a lock file prevents a second one).

Offline use: after the image is built (`docker save mecode-engine:v2 | gzip > engine.tar.gz`, `docker load < engine.tar.gz` elsewhere), nothing needs the network.

## Data folder

Default: Linux `~/.config/MeCode-V2`, macOS `~/Library/Application Support/MeCode-V2`, Windows `%APPDATA%\MeCode-V2`. Override with `MECODE_USER_DATA=/path`. Contents: `state.json` (progress, one backup), `drafts/` (your saved code, one file per problem+language), `packs/` (managed problem packs; the bundled pack is copied here on first run and never overwritten), `settings.json` (execution limits), `server.lock`.

Other environment variables: `MECODE_PORT` (fixed port instead of an ephemeral one; still loopback only), `MECODE_ENGINE_IMAGE`, `MECODE_LAUNCH_FILE` (also write the launch link to a private file).

## Writing and importing problems

See `docs/DEVELOPMENT.md` for the pack format. `node scripts/make-demo-pack.cjs out.json` writes a small example pack.

## Tests

    node --test "tests/unit/*.test.cjs"                                   # unit + fake-engine + local-web socket tests
    MECODE_REAL_DOCKER=1 node --test tests/integration/docker.test.cjs     # real containers (needs the image)

Without `MECODE_REAL_DOCKER=1` the integration tests are reported as skipped, not passed.

## Status / limits

- Catalog is the first slice (3 problems); the Blind/NeetCode-scale catalog is a separate task. CI and platform web archives: see `docs/CI-AND-DELIVERY.md`.
- Runner and submission share a container user (local practice, not an anti-cheat or multi-tenant service).
- Windows/macOS: archives exist (`npm run package:platforms`) and CI checks structure and launcher start-up, but the Docker/engine path is untested there.
