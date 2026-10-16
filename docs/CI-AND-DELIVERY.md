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

- Unit gate is now 140 tests; the extracted package runs 111 (dev-only tests excluded from archives: t13-archive-verify, t18-catalog-gate, t27-provision, t29-launcher-stop, t29-wrong-baseline). Counts follow the actual enumeration (`node --test tests/unit/*.test.cjs`), not an estimate.
- Provisioning import inspects the `docker save` tar BEFORE `docker load` and fails closed unless there is exactly one regular `manifest.json` whose every entry has a nonempty RepoTags consisting only of the alias (an optional `index.json`/`repositories` may not name another tag). It also checks the recorded platform INCLUDING variant on the already-present and post-load paths. Scope: tag-overwrite protection for an honest export, not publisher authentication or a same-user security boundary; no native ARM/Windows/macOS execution is claimed.
- `acceptedAt` must be a real ISO-8601 UTC instant; a bad value in the primary state falls back to the backup like any other invalid state.
- The renderer re-derives the ACCEPTED qualification on every render from the exact text it submitted (private to the page); a late result, edit, save or navigate away/back never shows a bare ACCEPTED for a different buffer.
- `catalog-dev` wrong baseline `dock-pairing` still counts INDEX pairs (so it stays wrong against the distinct-weight-pair reference) but uses linear frequency accumulation; timeouts, limits, case sizes and the FULL 111 gate are unchanged.
- `scripts/verify-archives.cjs` now awaits the launcher process group it spawned (bounded; SIGTERM, then SIGKILL escalation reported as a failure), keeps the exit status, and asserts that containers carrying that install's label are gone (`scripts/lib/launcher-stop.cjs`). `scripts/leak-probe.cjs` prints bounded id/name/state/status/created/image/labels at each probe boundary. The final global "No task-owned containers left" assertion is unchanged; the owner of the earlier hosted leftover (run 38851020710) is still UNKNOWN.
- `scripts/verify-offline.cjs` checks non-loopback browser requests after the whole four-language flow.

## T31 repairs (after the T30 review)

- **Counts (actual enumeration, `node --test tests/unit/*.test.cjs`)**: unit gate is now 158 (T29's `t29-launcher-stop` file has EIGHT tests, not seven; T29 total was 140). New: `t31-lifecycle` (12), `t31-archive-policy` (6). `t31-archive-policy` is dev-only (needs `scripts/lib` and `.github`; excluded from archives like `t29-launcher-stop`); the shipped-package count is the actual extracted run: 123 (111 + the 12 `t31-lifecycle` tests; `EXTRACTED-UNIT tests=123 pass=123` locally on 659e538, with the real Linux launcher + strict stop code 0 + install containers absent). Real-Docker integration stays 6, cleanup stays 2, and a separate focused lifecycle file adds 2 (`tests/integration/t31-lifecycle-docker.test.cjs`). FULL stays 111.
- **R1 backend lifecycle** (`src/main/backend.cjs`): the engine worker is now `docker create` (bounded; exact unique name, same sandbox/security/resource flags as before, validated returned id) followed by attached `docker start -a -i <name>`. Cancellation (`stop()`) marks intent and the backend AWAITS the create reply; it never kills a pending create. After a successful create the stop-intent check and the spawn of `start` have no `await` between them, so nothing launches after stop; a created object is removed by exact name and its absence confirmed. Every worker is kept in `backend.workers` from before the create until its removal is confirmed (independent of `cur`), and `stop()` combines each worker's outcome, so a cleared `cur` or an empty `ps` cannot erase an unresolved creation or a failed retirement. A create whose outcome is unknown (timeout, killed client, unreadable id) can never be confirmed (`confirmed:false`, server exit 3, status names `docker rm -f <exact name>`). The default create runner starts the CLI in its OWN process group on POSIX (retained handle, no unref; whole group SIGKILLed on timeout and on parent exit), so a TERM to the harness/launcher group does not kill a pending create.
- Shutdown budget (inside the existing server 15 s bound): create `createMs` 4 s (+250 ms outer guard) + cleanup 5 s (strict total, existing) + final owned-label `ps` ≤5 s. No new sleeps or unbounded waits; no sweep/prune.
- Evidence labels: `t31-lifecycle.test.cjs` = FAKE daemon/clients (explicit barriers) driving the ACTUAL Backend, ported from the reviewer's T30 schedule with the bug-asserting expectations inverted; it goes RED at the named lifecycle/safety assertions on f6e81b9 (`T31-red-old-f6e81b9` log in the management dir). T31-8/T31-9 use REAL OS processes (node as the "docker" binary) to demonstrate the separate process group surviving a group TERM. The real-Docker file exercises the real daemon (start→stop, and stop at the earliest "starting" point) but cannot force the daemon to publish after a client close. The hosted ordering behind container f83e64739b3e is still inferred: the producer is the verify-archives launcher install `850bf7be-c416-488e-a70b-74e7b03dbb05` (not the following fresh integration/GUI install); we do not claim all historical leaks share one cause (run 38851020710's leftover remains unidentified).
- Bounded sanitized trace: `backend.trace` (phase, exact container name, install prefix, create state, UTC+monotonic) is printed as one `BACKEND-LIFECYCLE-TRACE` stderr line only when a shutdown is unconfirmed.
- **R2 archive-smoke policy** (`scripts/lib/launcher-stop.cjs` `teardownLauncher`, called by `scripts/verify-archives.cjs`): strict by default (exit 0 and confirmed absence of the install's containers, even if Docker stops answering later). `--docker-unavailable-smoke` is passed ONLY by the hosted macOS no-engine archive job; Docker is probed and logged (`LAUNCHER-DOCKER-BEFORE`) BEFORE launch, exit 3 is accepted only if Docker was unavailable before and after, and removal is reported `NOT ASSERTED`. Exit 2, escalation, available-before/unavailable-after and a flagged run on a host where Docker answers all fail. Windows archive smoke keeps its separate taskkill path and makes no POSIX-lifecycle or engine claim. The final CI "No task-owned containers left" assertion is unchanged.
- Not certified: native macOS/Windows engine execution, an uncached-host offline install, or any broad security claim.

## T33 repairs (after the T32 review; two defects, nothing else changed)

- **Positive create exit is UNKNOWN** (`src/main/backend.cjs` `_start`): only `docker create` exit 0 with a well-formed id marks a worker `created`. Every other completion (positive CLI exit including transport/response loss and handled-signal 128+N, timeout, kill, abort, unreadable id) is `unknown`: exact worker/name retained, `confirmed:false`, never upgraded by an empty `ps`, no stderr parsing. The former `failed` state and the "No such container accepted" branch are gone. Consequence: a create that merely errors (for example exit 125) now ends in `cleanup-unconfirmed` naming `docker rm -f <name>` instead of `unavailable`; shutdown then exits 3, not 0. The T31-6 test contract was adjusted for exactly this.
- **One absolute stop budget** (`Backend` option `stopMs`, default 12000 ms = 3 s margin inside the unchanged server 15000 ms exit): `stop()` sets one deadline. Every Docker command from stop intent on (`_dk`) is capped by the REMAINING budget and is not issued once spent: startup preflights (version/image/stale ps/rm/recheck, cancelled immediately by stop intent and re-checked via `stopped` before every further step), retained-worker retirements (the existing per-worker `cleanupMs` budget is additionally capped by the deadline), the in-flight `kill`, and every command of the strict final sweep (ps, per-ID rm, recheck ps). The create runner is called synchronously after the last stop check (no `await` between), so no create/start/reprepare follows stop intent. At expiry the receipt is `confirmed:false` with the exact owned names in `reason`, the pending create CLI process group is terminated through an `AbortSignal` (never launched if already aborted), attached clients are killed, and workers stay retained as recorded uncertainty. No sleep grace, no longer server timer, final absence is still strict.
- **Evidence labels**: `tests/unit/t33-lifecycle.test.cjs` (13 tests) = FAKE daemon with explicit barriers driving the ACTUAL Backend; the three create-exit tests feed REAL node-child exit shapes (1, 125, 143) through the REAL `dockerCreateDetached`; T33-2h uses REAL OS processes for abort. The reviewer's 16.4 s slow probe is replaced by an equivalent deterministic schedule (small `stopMs`, barrier-held commands). RED on e8e8860: `T33-red-old-e8.log` in the management dir. Real Docker (`tests/integration/*`, MECODE_REAL_DOCKER=1) is unchanged and cannot force the daemon to publish after a client close.
- Counts: unit gate 171 (158 + 13 new `t33-lifecycle`; `t31-lifecycle` still 12). `t33-lifecycle` is shipped in the archives (needs only src/); actual extracted run locally: `EXTRACTED-UNIT tests=136 pass=136` (123 + 13), real Linux launcher strict stop code 0, install containers absent.

## T35 repairs (after the T34 review; two residual defects, nothing else changed)

- **Non-create CLI children no longer depend on a parent-owned timer**: the default `dockerExec` retains each child handle (`liveExecs`), accepts an abort signal (SIGKILL, never launched once aborted) and is killed by the process `exit` hook. `stop()` aborts in-flight startup preflights (`_preAbort`) and waits (<= 1 s, inside the stop budget) for them to close; stop-budget expiry aborts every outstanding command. Server 15 s timer, Backend 12 s `stopMs`, exact-owned removal semantics and pending-create UNKNOWN are unchanged. No global process search/kill.
- **No create after a synchronous `starting` observer stops the backend**: `_start` re-checks `stopped` right after `_set('starting')` and before worker allocation/create.
- **Evidence labels**: `tests/unit/t35-lifecycle.test.cjs` (5 tests): T35-1 FAKE daemon + reentrant observer (zero creates); T35-2..5 REAL default `dockerExec`/`execFile` with a task-owned fake `docker` executable on a private PATH, a REAL blocking OS child, server-style `process.exit`, and PID absence read from `/proc` (cancellation, stop-receipt ordering, budget expiry, emergency exit). RED on 317cfa0: `T35-red-old-317cfa0.log` (0/5 pass) in the management dir. NOT real Docker. `tests/integration/t31-lifecycle-docker.test.cjs` now has 3 real-Docker tests: the former "create in flight" case is corrected to the pre-create observer case (zero creates), and a separate real genuinely-pending-create case keeps cancellation coverage.
- Counts: unit gate 176 (171 + 5); shipped-package count is expected 141 (136 + 5; not yet re-extracted). Focused real lifecycle file 3 (was 2); integration stays 6, cleanup 2.

## T38 repair (T37-B1: pre-load image-platform check)

- `scripts/provision-engine.cjs import` now reads the `docker save` manifest.json `Config` entry (exactly one regular archive file, JSON object, <= 1 MiB) and requires its `os`/`architecture`/optional `variant` to be well-formed and equal to the bundle manifest BEFORE `docker load`, also when the alias is absent. Missing, duplicate, non-regular, malformed or mismatching config metadata is refused with zero load calls. Existing-alias, tag, size/digest, daemon-platform and post-load checks are unchanged. Integrity only: not publisher authentication or a general archive reader.
- Counts: unit gate 177 (176 + 1 new `t27-provision` test; that file is dev-only, so the shipped-package count stays 141).
