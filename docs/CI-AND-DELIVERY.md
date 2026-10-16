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
| unit (96)             | `npm test`                                                                                         |
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

## T27 additions (accepted solutions + offline provisioning)

- Unit gate was 126 tests at T27 (the earlier text said 120 shipped; the extracted-package run actually enumerated 110).
- `npm run test:e2e` also runs `tests/e2e/accepted-gui.test.cjs` (real Chrome + real server + real engine: accepted submit, wrong draft saved, restart, explicit "Load accepted solution").
- `scripts/verify-offline.cjs` (dev-only, real Docker) runs after the Linux archive is built: export under a task-owned alias, remove only that alias tag, fresh extracted package and fresh data, missing-image state, verified import, Retry, four real accepted submissions. Evidence is scoped to the app/browser, not whole-host isolation. Nothing is uploaded; only failure-time text/screenshots follow the existing 3-day policy.
- Historical rootful d9 cleanup race: still an unresolved residual; none of these gates claims to fix it.

## T29 repairs (after the T28 review)

- Unit gate is now 139 tests; the extracted package runs 111 (dev-only tests excluded from archives: t13-archive-verify, t18-catalog-gate, t27-provision, t29-launcher-stop, t29-wrong-baseline). Counts follow the actual enumeration (`node --test tests/unit/*.test.cjs`), not an estimate.
- Provisioning import inspects the `docker save` tar BEFORE `docker load` and fails closed unless there is exactly one regular `manifest.json` whose every entry has a nonempty RepoTags consisting only of the alias (an optional `index.json`/`repositories` may not name another tag). It also checks the recorded platform INCLUDING variant on the already-present and post-load paths. Scope: tag-overwrite protection for an honest export, not publisher authentication or a same-user security boundary; no native ARM/Windows/macOS execution is claimed.
- `acceptedAt` must be a real ISO-8601 UTC instant; a bad value in the primary state falls back to the backup like any other invalid state.
- The renderer re-derives the ACCEPTED qualification on every render from the exact text it submitted (private to the page); a late result, edit, save or navigate away/back never shows a bare ACCEPTED for a different buffer.
- `catalog-dev` wrong baseline `dock-pairing` still counts INDEX pairs (so it stays wrong against the distinct-weight-pair reference) but uses linear frequency accumulation; timeouts, limits, case sizes and the FULL 111 gate are unchanged.
- `scripts/verify-archives.cjs` now awaits the launcher process group it spawned (bounded; SIGTERM, then SIGKILL escalation reported as a failure), keeps the exit status, and asserts that containers carrying that install's label are gone (`scripts/lib/launcher-stop.cjs`). `scripts/leak-probe.cjs` prints bounded id/name/state/status/created/image/labels at each probe boundary. The final global "No task-owned containers left" assertion is unchanged; the owner of the earlier hosted leftover (run 38851020710) is still UNKNOWN.
- `scripts/verify-offline.cjs` checks non-loopback browser requests after the whole four-language flow.
