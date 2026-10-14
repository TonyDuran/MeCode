# ENGINE-1 fixed-command controller (code-only prototype)

Self-authored by Talos. This is not a learner-code runner, an accepted isolation
engine, or independent engineering/security/QA approval. Run/Submit remain disabled.
This Linux-only PoC requires a local rootless Docker daemon for the invoking user;
remote daemons, rootful Docker and Docker Desktop are not supported. No workspace
wiring, package dependencies or host changes are included; CI runs mocks only.

## Safe verification (no Docker)

From the repository root, Linux with CPython 3.10+:

    python3 -B -W error -m unittest discover -s prototypes/docker-engine -v

Tests use an in-process fake Docker transport. Transport tests mock Popen, selector,
clock and pipe I/O; they do not start subprocesses, contact a socket, run Docker,
pull images or execute learner source. Temporary test state uses Python's temp
facility; use an owned scratch directory via TMPDIR for test artifacts.
Both test classes inherit a Popen-denial guard; explicit local capture mocks are
the only replacements. An unmocked transport test cannot launch the Docker CLI.

## Fixed interface and envelope

`controller.py` accepts only `--fixed-smoke` (and help). Missing mode, source/file/
command/env/endpoint flags, positionals, stdin-file marker and trailing arguments
are rejected before transport construction. The flag is an intent selector, NOT
an approval mechanism. Importing this module does not execute Docker. There is no
shell, arbitrary program API, supplied source, fixture selection, or host fallback.

Only a separately approved future live invocation may use the real adapter. No
live command was run for this implementation. The existing explicit `--host`
approval denial remains a separate integration dependency; invoking this Python
controller is NOT an alternate way around that denial. An approved execution path
must cover this controller and its actual Docker argv, not just Python generally.

Fixed constants:

- Executable: `/usr/local/bin/docker`.
- Required endpoint: `unix:///run/user/{uid}/docker.sock`, where `uid` comes only
  from trusted `os.getuid()` at module import, not an environment variable or input.
- Image: `docker.io/library/python@sha256:cfe2e24a75302a15934d37c2d86412893c0aa934dc3a97cbb439d04c01890ca9`.
- Platform: `linux/amd64`.
- Payload: `/usr/local/bin/python3 -I -B --version`.
- Expected output: exactly `Python 3.14.8` followed by LF, with no stderr.

The endpoint is not learner- or environment-configurable. HOME, UID, USER and
XDG_RUNTIME_DIR do not select the socket. There is no discovery or fallback to a
different user's socket, rootful socket, remote endpoint or ambient Docker context.
Each CLI call rechecks the actual adapter endpoint against the derived local
expected endpoint and rejects every ambient `DOCKER_*`
variable, even a matching host. Calls always carry explicit `--host`, an empty
private temporary `--config` directory, DEVNULL stdin and a minimal process
environment. No inherited Docker credentials, context, proxy or TLS settings are
used. Image-defined environment remains part of the pinned image, not host input.

Before create, inspect daemon rootless/builtin-seccomp/Linux/cgroup-v2/systemd
metadata and local image RepoDigests plus OS/architecture. Accept only the full
repository spelling or Docker's known `python@sha256:...` spelling; image config ID
is not manifest verification. No tag fallback or pull; create uses `--pull=never`.
Daemon JSON `Warnings` are retained in the result as `daemon_warnings`. Any warning
mentioning memory, swap, PID/PIDs or CPU (case-insensitive whole words) fails closed;
cpuset/IO-only warnings are allowed because those controls are not relied upon.
Missing/malformed warning metadata fails closed; JSON null means no warnings.
An unconfined seccomp entry is rejected even if builtin seccomp is also listed.
Reject image-declared volumes, exposed ports and active healthchecks. An offline
image without matching RepoDigests fails closed (no weaker provenance fallback).

The fixed create argv requests network `none`, no published ports, no user-specified
host mounts, numeric UID:GID 65534:65534, drop ALL capabilities, no-new-privileges,
read-only root, private IPC/cgroup namespaces, default private PID namespace,
init/reaper, no restart, no persistent container logs, memory and memory+swap 256m,
PID limit 32, 0.5 CPU, core=0, nofile=64, /tmp tmpfs 16m with noexec/nosuid/nodev,
and /dev/shm 1m. No privileges, devices, extra groups, security-profile weakening,
network attachment, namespace sharing, ports or socket mount can be supplied.
Default seccomp is retained; no AppArmor effectiveness claim is made.

## Bounds, state and cleanup

- One 5-second monotonic work deadline starts before readiness/create. Each CLI
  call receives at most 2 seconds and no more than the remaining work budget.
  Cold starts or slow readiness fail, rather than extending the deadline.
- Capture stores at most 64 KiB combined stdout/stderr per CLI call, not per stream.
  It reads at most one byte beyond remaining capacity to detect overflow. Failure
  output keeps only a bounded prefix and marks truncation. UTF-8 replacement and
  JSON encoding may expand the rendered evidence beyond the raw byte cap.
- A blocked client is killed and given a separate 2-second reap budget. This is
  not proof of container termination. Capture and lifecycle tests simulate this;
  OS scheduling, process creation and filesystem I/O are not hard real-time bound.
- Full, lowercase 64-hex container IDs only. Cleanup sends `stop --time 1` to that
  ID, attempts force-removal even if stop fails, then always checks absence via successful
  `ps --all --quiet --no-trunc --filter id=<full-ID>`. Each cleanup call has its
  own 2-second API budget, plus the separate client reap budget. Cleanup is outside
  the work deadline. Removal failure does not skip this query. Only an empty,
  stderr-free, successful, within-budget query confirms absence; an error,
  warning, timeout, output overflow or nonempty listing never does.
- No short IDs, names/prefixes as deletion targets, broad kill, prune, image removal
  or automatic retry. A timed-out create with clean stderr and exactly a full ID
  (optional final LF) permits one bounded exact-ID inspection outside the work
  deadline. Only matching `Id`, generated `/Name`, `mecode.task=ENGINE-1` and
  `mecode.owner=talos` labels authorize exact-ID cleanup. The run stays UNAVAILABLE
  and latched even if absence is confirmed. Unknown/noisy replies or failed identity
  verification leave cleanup unconfirmed. No name lookup/removal is attempted.
- Durable state defaults to `~/.local/state/mecode-engine1/`, outside the checkout
  and logout-cleared runtime directories; no XDG_RUNTIME_DIR/XDG_STATE_HOME override.
  Its user-owned 0700 directory holds `lock` and `pending.json` (0600). Directory
  and lock owner/type/permissions are checked; symlink directory/lock is rejected.
  Nonblocking flock coordinates controller processes sharing this state path,
  including other worktrees using the same home. The lock inode is never unlinked.
  `pending.json` is atomically recorded and fsynced before create, then records the
  full ID and `start` stage before start; `exit_inspect` is recorded before inspection.
  Crash, SIGKILL, uncertain create and every failed run retain the persistent latch.
  Subsequent controllers refuse to run. The local legacy `.state/pending.json`,
  if present, also blocks execution; no automatic migration/deletion is performed.
- CLI SIGTERM and ordinary SIGINT enter cancellation cleanup when a full ID is known.
  Repeated signals, SIGKILL, host death, hung kernel operations and unavailable daemon
  cannot be made safe by this process. The persisted latch is a recovery warning,
  not an external watchdog. No self-reset command is provided.
- `FIXED_SMOKE_OK` requires exact output, inspected matching ID, exited/not-running,
  exit code zero, no OOM/error, a removal attempt and clean daemon-reported absence.
  Everything else is `UNAVAILABLE`; the controller instance stays latched too.

Operators must reconcile retained state through existing approvals before any
further live trial, using the recorded ID/name as evidence, not blanket deletion.
The operator recovery record is `~/.local/state/mecode-engine1/pending.json`. Preserve it
across checkout replacement/cleanup. Check any legacy worktree `.state/pending.json`
before switching revisions; this code does not discover legacy records in other
worktrees. Operator/Atlas must obtain approved reconciliation before migration or
clearing a latch; neither this document nor a path change authorizes Docker access.
Do not remove the failure latch merely to retry. The lock does not coordinate
clients using a different state directory/home or arbitrary clients of the daemon.
Same-UID processes and the daemon remain trusted; no per-task socket authority exists.

## Verification boundary / pending integration

Mocks prove controller decisions and argv construction only. They do not prove CLI
compatibility, endpoint ownership, current image presence, flag acceptance, kernel
resource enforcement, effective seccomp/AppArmor, mount masks, networking denial,
or actual container/descendant cleanup. `cleanup_confirmed` means an exact-ID
removal attempt followed by a clean empty daemon listing, not independent
cgroup/process proof or a claim that the removal command itself succeeded.
The daemon may inject /etc/hosts, hostname, resolv.conf and synthetic mounts even
with no user-specified bind mount. Resource caps exclude daemon/controller overhead.

References: planning `DOCKER-CONTINGENCY.md` trial envelope, Athena A3–A10, M1–M14,
F1–F5 and R7–R8 in `engine-spike-1/ATHENA-DOCKER-REVIEW.md`. This artifact implements
controller-side portions only; it does not close those acceptance conditions.

Next, separately approved work: operator/Atlas resolve the precise explicit-endpoint
execution approval; independent engineering review; then approved fixed smoke and
Themis effective-control tests. Those tests need their own reviewed probes and
scope, not learner input added to this controller. No dispatch occurred here.

Rollback of this code-only change: remove only the new `prototypes/docker-engine/`
source/test/docs files and the requested planning handoff if unwanted. No Docker or
host rollback is needed for this task. After any future live run, preserve/reconcile
`~/.local/state/mecode-engine1/` and any legacy `.state/` evidence before removing
anything; deleting either directory does not stop containers. Rolling back to the
old repo-local default without reconciliation would bypass the new durable latch.
