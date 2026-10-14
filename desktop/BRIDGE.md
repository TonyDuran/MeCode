# Experimental Linux judge bridge

Bridge and integrity corrections self-authored by Talos; integrated renderer by
Prax. Working code/mock PoC, not hostile-code sandbox certification, independent
security/QA approval or deployment approval. The integrated Run control now calls
the bridge when admitted. Submit remains unavailable; ordinary launches are offline.

## Renderer contract

The sandboxed preload exposes exactly these promise-returning methods:

    window.mecodeJudge.capabilities()
      -> {enabled: boolean, reason: string}
    window.mecodeJudge.run({source: string, problemId: 'sum-array-v1'})
      -> {status: 'JUDGED' | 'UNAVAILABLE' | 'INVALID_INPUT',
          verdict: 'ACCEPTED' | 'WRONG_ANSWER' | 'RUNTIME_ERROR' | null,
          reason: string | null, elapsed_s: number | null}

Only packaged Linux (`app.isPackaged === true`) AND exact
`MECODE_EXPERIMENTAL_JUDGE=1` captured at app launch enable admission. Development
launches cannot enable judging, even with that variable; there is no dev bypass.
Set that launch variable only in an approved trial environment; this
document does not grant permission to execute submissions. Capabilities returns
`experimental_opt_in_not_health` when enabled: it makes no Python/Docker/image
probe and does not report live health, busy state or latch state. Otherwise its
reason is `packaged_required`, `opt_in_required`, `linux_only`, or `untrusted_frame`. IPC transport
failure is `bridge_transport_failed`. There is no Mac judge claim.

Main validates exact webContents and main-frame identity, both frame/document URLs
against the exact bundled file URL (no query/hash), and document generation again
before delivering a result. Same-URL reload, window replacement and renderer loss
invalidate active work. Source must be a well-formed Unicode string of <=16,384
UTF-8 bytes. Only the exact two request keys and known problem ID are accepted.
No path, command, argv, environment, budget or IPC channel comes from the renderer.
Navigation uses the pinned Electron 44.7.2 event details `isMainFrame` and
`isSameDocument`, not deprecated positional arguments. The preload snapshots input
inside an exception boundary; missing/throwing encoders or request accessors return
INVALID_INPUT without IPC. Transport exceptions produce fixed unavailable responses.
The preload preflights size/schema too; main remains the authority. Node integration
stays off, context isolation and renderer sandbox stay on. No port or service.

`JUDGED` has a verdict, null reason, and finite elapsed seconds in [0,28] from the runner.
Other statuses have null verdict and elapsed; reasons are fixed diagnostic codes,
not learner output, exception strings, paths or Docker diagnostics. `INVALID_INPUT`
is not a learner verdict. `UNAVAILABLE` must not appear as a wrong answer.

## Trusted Python boundary and requirements

After frame/gate/schema/concurrency checks, and before **every** Python spawn,
main verifies the sidecar directory against the SHA-256 and exact byte-size pins
in app-bound `judge-assets.cjs`. Runtime membership must be exactly the three
regular files below: no extra modules, directories, symlinks or hardlink aliases.
The judge directory itself must be a non-symlink directory. Directory enumeration
is bounded to the expected entries plus one. Each read uses a fixed-size buffer
of pinned size plus one, handles partial reads and checks file/directory identity
and metadata for changes. Files are opened with NOFOLLOW and NONBLOCK; unsupported
NOFOLLOW, missing/modified/oversized/unreadable assets or unexpected membership
fail closed as `assets_unverified` and latch the bridge until app exit. No Python
spawn or recovery-state access occurs on that path. Capabilities does not perform
this verification and does not assert integrity or readiness.

This is a bounded drift check, not a race-free loader: parent directories and the
installation must be trusted, and Python later reopens the paths. A concurrent
writer can race verification; someone able to replace the application can replace
the verifier and its manifest too. Equal-user installation authentication is NOT
provided. No owner/permission changes or alternate execution path are performed.

Main invokes only `/usr/bin/python3 -I -B <absolute trusted bridge_cli.py>`, with
shell disabled, fixed cwd at the asset directory and pipes for stdin/stdout/stderr.
The environment contains only PATH=/usr/local/bin:/usr/bin:/bin, LC_ALL=C.UTF-8,
and HOME from the OS account database (`os.userInfo().homedir`), not inherited HOME.
No caller-selected Python, Docker, endpoint, state directory or environment override
is supported. Do not use a different HOME to evade a recovery latch.

The CLI adds only its own trusted directory to Python's isolated import path,
reads at most 100,001 bytes to enforce a 100,000-byte JSON envelope cap (including
worst-case escaped source), rejects duplicate/extra keys and malformed encoding,
and enforces a two-second stdin/EOF deadline. It calls `edited_runner.submit` and
projects one fixed-shape JSON line <=1,024 bytes. Submitted source is never compiled,
evaluated or executed by host Python. CLI argv accepts no options/positionals.
Calling the CLI with valid input is a real Docker trial, not a simulation; only the
coordinator may conduct the separately approved benign trial on reviewed bytes.

External Linux prerequisites, not installed/bundled by this change:

- Python >=3.10 at `/usr/bin/python3` (stdlib only; actual tested system Python 3.14.4).
- Docker CLI at `/usr/local/bin/docker`; the existing leaf uses only the explicit
  local rootless `unix:///run/user/<uid>/docker.sock` endpoint.
- Linux rootless Docker with cgroup v2/systemd, builtin seccomp and effective limits.
- Preloaded linux/amd64 image (no pull):
  `docker.io/library/python@sha256:cfe2e24a75302a15934d37c2d86412893c0aa934dc3a97cbb439d04c01890ca9`.
- Trusted install assets and account-owned recovery state; no retained pending
  record. Reconcile through the operator, never auto-delete/reset recovery state.

The existing controller and edited runner are unchanged. Their pinned no-network,
read-only, unprivileged Docker execution envelope remains the only submitted-source
execution path. No unrestricted-host fallback or alternate Docker endpoint exists.
See `../prototypes/docker-engine/EDITED-RUNNER.md` for the full envelope and caveats.

## Deadlines, concurrency and recovery

One active CLI per app bridge, no queue; concurrent calls return `busy`. The existing
cross-process flock and persistent `~/.local/state/mecode-engine1/pending.json` also
serialize trials across app instances and the fixed-smoke runner. The controller
persists its latch before Docker activity and clears it only after verified judging
and exact-ID daemon absence. Source is not stored in that record.

Main gives the CLI 20 seconds, then SIGTERM for existing controller cleanup, then
at most 8 seconds of grace before SIGKILL and a fail-closed response, even if no
close event arrives. Invalid/oversized output, any stderr, pipe/process failure,
reload/renderer loss and app quit also fail closed. App quit waits for this bounded
cancellation path. A late success never overrides cancellation. The CLI stdin
and inner work/cleanup budgets remain separately bounded; filesystem/scheduling
operations are not hard-realtime guaranteed.

Main latches admission for the rest of its lifetime on ambiguous failure or any
engine UNAVAILABLE. A normal JUDGED result permits another run. Capabilities still
reports only launch opt-in. Restarting the app does NOT clear the controller's
persistent latch. An outer failure before controller state creation may have only
the app-lifetime latch, because no Docker call can precede the durable record.

Killing/reaping Python is NOT evidence of container cleanup. Docker clients create
separate sessions in the existing controller, so outer SIGKILL does not prove those
clients/containers/descendants are gone. The persistent record is the recovery
barrier, not an external watchdog. No automatic retry, endpoint change, state reset,
or name-based deletion is supplied. Operator reconciliation remains mandatory.

## Packaging and evidence

`node desktop/stage.cjs` stages eight manifest-verified renderer files, including
the integrated `run-ui.js`, and
exactly `bridge_cli.py`, `controller.py`, `edited_runner.py` into ignored
`desktop/judge/`. Staging verifies selected repository-source bytes against the
app-bound pins before replacing that directory, then verifies exact staged
membership/bytes. Repository tests/docs are never copied into judge/.
`package-assets.cjs` allowlists app files; Forge copies judge/ as an extraResource
outside app.asar because system Python cannot import from ASAR. Packaged main uses
`process.resourcesPath/judge/bridge_cli.py`; the development prototype path remains
inert because unpackaged admission is refused. Non-Linux packages may carry the
same three inert assets but cannot invoke
them through this bridge. Python tests, fixture modules and recovery state are not
part of that allowlist. The integrated renderer still embeds its recorded
fixture evidence; no new Python fixture execution is bundled.

The app allowlist includes `judge-assets.cjs`, so the pins ship inside app.asar.
The Packager 20.3.0 `afterComplete` hook in `package-check.cjs` checks pre-ZIP Linux
or MeCode.app macOS resource layouts: the actual ASAR must contain the exact
source verifier/manifest module, packed and not linked, and final judge/ must
match all pins and exact membership. It reads but never executes ASAR contents.
This is build-time self-consistency against the source on disk, not an independent
trust anchor. The ZIP maker runs afterwards: this hook provides no post-ZIP
authentication or tamper detection. Bind the reviewed source and finished ZIP by
separate hashes and inspect the final archive before handing it to QA.
The hook uses @electron/asar from the existing pinned Forge/packager dependency
tree; no new dependency or runtime Node module is bundled. Changes to the leaf
require explicit review and pin updates; staging never silently regenerates pins.

External Python assets are not covered by ASAR integrity. On Linux, the embedded
ASAR-integrity fuse is not enforced; ASAR-only loading does not authenticate its
contents. On macOS, fuse settings alone do not establish trusted distribution of
an unsigned/re-signable bundle. These checks do not authenticate a writable
installation on either platform. Trusted distribution/install assumptions and
independent review remain prerequisites. The hook tests build tiny real ASAR
fixtures for both resource layouts, not runnable Electron packages or Mac UAT.

F4 disposition: retain the existing `GrantFileProtocolExtraPrivileges` default
for this bounded correction, rather than change file-origin semantics without
real Electron persistence/navigation testing. This is deferred hardening, not a
claim that the privilege is required. CSP/network denial, sandboxing, navigation
and permission checks remain unchanged. Athena/Themis must review a later change
and its real file-origin behavior; the present default is not newly certified.

Checks from repository root with the existing desktop development dependencies:

    node --test desktop/test/*.test.cjs prototypes/trusted-workspace/test_run_ui_contract.cjs
    python3 -B -W error -m unittest discover -s prototypes/docker-engine -v
    node desktop/stage.cjs
    git diff --check

IPC/preload/process mock tests cover packaged/platform gate, real-filesystem
sidecar refusal before any mocked spawn, staging/package assertions, validation
exceptions, schema, UTF-8 cap, exact/stale frame,
single-flight admission, timeout/TERM/KILL/latch, invalid/overcap output, safe env,
and packaging allowlists. Python tests mock submit or Docker/Popen; no submitted
source executes on the host. The CLI process tests really launch trusted isolated
Python with malformed/oversized/no-EOF input ONLY, never a valid submission.

The earlier ENOTCACHED/fuse-module failures were historical. Prax's R3/R4 renderer
correction is integrated; the Node-only cross-boundary test uses the real bridge
with a mocked child and the real renderer in a VM. Desktop `npm test` and CI run
that test, not the Run UI browser suite or real Electron IPC integration.
Build, artifact hashes and runtime observations for each final candidate belong
in its separately bound handoff, not inferred from unit-test success.
Missing `generation-receipt.json` remains an explicit blocked prerequisite for the
raw evidence cross-check, not a fabricated or suppressed pass. Prior immutable-shell
GUI QA does not validate this integrated revision. Athena's R1/R2 correction review
is scoped to a private benign packaged-Linux trial, not public/hostile execution.
Independent Themis QA, sandbox-preserving Electron UAT and coordinator live
cleanup/limit verification remain open. The leaf's shared Python interpreter/public cases allow judge tampering;
ACCEPTED is not evidence of tamper-resistant grading or containment certification.

Rollback: restore only this correction's desktop changes to its recorded pre-task
snapshot, not HEAD (which excludes prior uncommitted integration work). Preserve
Prax's renderer, the eight-asset integration corrections and all recovery state.
Removing app/code files does not stop or reconcile a container.

## Navigation and recovery note

The bridge still authorizes only the exact owner, main frame and workspace URL. The link-prevention preload listeners and the main-owned `Restore saved workspace` menu action add no IPC channel and no bridge key; after a foreign document has committed, capabilities and Run keep returning `untrusted_frame` until the user restores the workspace. Restoring does not clear a latch or resume a Run (navigation already cancelled any active Run).
