# CI, quality gates and platform delivery (T11)

## Pinned toolchain

Node 26.7.0 and npm 11.19.0 (`.node-version`, `package.json` engines). Dev dependencies are exact pins with a lockfile
(`npm ci --ignore-scripts`): typescript 6.0.3, eslint 10.12.0 (+ @eslint/js 10.0.1, globals 17.13.0), prettier 3.9.10,
playwright-core 1.58.2, @types/node 26.6.5. The app itself has zero runtime dependencies.
`npm run verify:toolchain [-- --runtime]` asserts these and logs the DISTINCT runtime identities (Docker engine mode, guest
Python/Node/g++/gcc inside the engine image - the guest Node is not the build Node).

## Local commands (same as CI)

| Gate                  | Command                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| format / lint / types | `npm run format:check`, `npm run lint`, `npm run typecheck`                                        |
| unit (86)             | `npm test`                                                                                         |
| real Docker (6)       | `MECODE_REAL_DOCKER=1 npm run test:integration` (needs `docker build -t mecode-engine:v2 engine/`) |
| real-browser GUI E2E  | `npm run test:e2e` (needs an installed Chrome; or set `MECODE_E2E_CHROME=/path/to/chrome`)         |
| negative canaries     | `npm run test:canary`                                                                              |
| archives              | `npm run package:platforms && npm run verify:archives`                                             |

Type check scope: `checkJs` over `src/` and `scripts/` (Electron entry files `src/main.cjs`, `src/preload.cjs` are excluded: Electron is not
a dependency and that wrapper is not shipped). `strict` and `noImplicitAny` are OFF because the existing code base is untyped CommonJS;
the gate still checks property/call/assignment consistency (it found and we fixed real undeclared class fields). It is a ratchet, not full strictness.
No `@ts-nocheck`.

## GUI E2E and canaries

`tests/e2e/gui.test.cjs` drives a real Chrome (playwright-core, Chromium sandbox ENABLED) against the real server and real Docker engine:
import an external pack through the file input, WRONG_ANSWER, ACCEPTED, Save, stop + restart the server, draft/status restored,
edit the pack on disk, Reload, stale status + changed verdict, no non-loopback requests, no containers left.
`tests/canary/run-canaries.cjs` requires four expected failures, each at a NAMED assertion with evidence that the real engine/browser ran:
engine control (green), engine wrong assertion, GUI wrong assertion, and a mutated app (comparator accepts everything) caught by the unchanged GUI test.

## Platform archives (local web, not Electron)

`npm run package:platforms` writes `dist/platform/`: `.tar.gz` + `.zip` for linux, macos, windows plus `SHA256SUMS`. Each holds the app source,
launcher scripts (`start.sh` / `start.command` / `start.cmd`, `build-engine.*`), problem packs, the engine Dockerfile + runner, docs, unit/integration
tests, `INSTALL.md` and `MANIFEST.json` (exact source revision/tree, per-file sha256 and mode). Rebuilding the same commit yields byte-identical archives.
Unsigned. Docker and Node are manual prerequisites. Only Linux x64 + Docker is exercised end to end; Windows/macOS get structure and
launcher start-up checks in CI (no Docker run). CI builds and discards these archives; nothing is published.
