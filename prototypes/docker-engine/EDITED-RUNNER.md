# Experimental edited-Python leaf

Self-authored by Talos. Code/mock-tested PoC, not a public service, hostile-code
sandbox certification, browser integration, or QA/deployment approval. The original
`controller.py --fixed-smoke` CLI is unchanged; it still rejects source arguments.

## Callable contract

From a trusted Python caller with this directory on its import path:

    from edited_runner import submit
    result = submit(source, "sum-array-v1")

Import alone performs no execution. Calling `submit` with valid input uses the real
Docker transport. Never invoke it in a session where that actual Docker invocation
is denied. The existing explicit `--host` route is unchanged, not hidden or rerouted.
The coordinator has the existing approved session for live bounded trials; this
implementation session runs mocks only. No new up-front host approval is requested.

`source` must be an exact str, at most 16,384 UTF-8 bytes, defining `solve(nums)`.
It is compiled inside the container with filename `<submission>` and
`__name__ = "__submission__"`; `if __name__ == "__main__"` is not the entry contract.
Only the exact problem ID `sum-array-v1` is supported. No command, file, environment,
endpoint, budget, or Docker option is accepted from a submission. Invalid input
returns `INVALID_INPUT` without transport calls or state writes. No source is stored
in the recovery record. A submission can itself print source into captured output;
callers must treat all returned text as untrusted and potentially sensitive.

One container calls the function sequentially with the actual six trusted-judge
cases: empty -> 0, singleton [7] -> 7, positive [1,2,3,4] -> 10,
negative [-1,-2,-3] -> -6, mixed [-100,100,-3,8] -> 5,
duplicates [5,5,5,-5] -> 10. Inputs are fresh lists. Cases are fixed, public, and
not randomized; one submission's module state persists across its six calls.
The host compares returned exact integers to literal oracles. Bool, float, objects,
and out-of-domain integers normalize to null and produce `WRONG_ANSWER`.

Returned dictionary:

- `status`: `JUDGED`, `UNAVAILABLE`, or `INVALID_INPUT`.
- `verdict`: `ACCEPTED`, `WRONG_ANSWER`, or `RUNTIME_ERROR` only with `JUDGED`;
  otherwise null. `JUDGED` means the experimental protocol completed and daemon
  absence was confirmed, NOT that the answer was correct or containment certified.
- `problem_id`: the supported ID; invalid arbitrary IDs are not echoed.
- `reason`, `stage`, `container_id`, `cleanup_confirmed`, `stdout`, `stderr`,
  `truncated`, `daemon_warnings`, `elapsed_s`: existing lifecycle observations.

Syntax errors, missing/noncallable solve, and caught Python exceptions (including
SystemExit) produce the fixed exception record -> `RUNTIME_ERROR`, with no traceback.
Stdout is reserved for one JSON protocol record. Submission print/debug output can
invalidate it. Stderr is conservatively rejected because Docker CLI diagnostics and
container stderr share a stream. Both cause `UNAVAILABLE`, not a guessed verdict.
Duplicate JSON keys, extra records/fields, malformed encoding, and invalid protocol
shapes also fail closed. These are deliberate PoC restrictions.

Timeout, output overflow, nonzero attach exit, OOM/abnormal inspected exit, transport
loss and ambiguous cleanup remain `UNAVAILABLE` with null verdict. This first leaf
does not pretend a client timeout proves a learner TIME_LIMIT or a daemon error is
a learner exception. A caught wrapper exception is a different, explicit protocol
outcome. Cleanup/latch-clear failure always suppresses a previously computed verdict.

## Execution envelope and reuse

`_Submission` reuses the reviewed controller's readiness, create recovery, state,
exit inspection, cleanup and deadline code. Three small hooks select fixed create
argv, attached stdin, and output judging; fixed smoke behavior remains covered by
its unchanged tests. No duplicate cleanup implementation or host execution fallback.

The leaf retains the pinned image and platform, `/usr/local/bin/docker`, empty
private Docker config, explicit `unix:///run/user/{os.getuid()}/docker.sock`, ambient
DOCKER_* rejection, rootless/builtin-seccomp/cgroup-v2 checks, no pulls, no network,
read-only root, UID:GID 65534:65534, drop ALL caps, NNP, private namespaces, init,
256 MiB memory/no additional swap, 32 PIDs, 0.5 CPU, core=0, nofile=64,
16 MiB noexec/nosuid/nodev tmpfs, 1 MiB shm and no persistent logs. No ports, host
mounts, daemon-socket mount, or user-supplied environment. See README.md for the
full fixed envelope and residual host assumptions.

Only changes to container argv: `create --interactive`, followed by the fixed
Python `-I -B -c WRAPPER` program instead of `--version`; `start --attach
--interactive <full-ID>` attaches stdin. Submitted source never appears in Docker
argv or environment. The wrapper itself is trusted fixed text in argv. Source
crosses stdin as raw UTF-8, with EOF after the final byte. There is no TTY.

The adapter uses nonblocking writes (chunks <=4096), drains output concurrently,
and handles partial writes, backpressure and early pipe closure. Input delivery
shares the existing monotonic capture deadline. Output is bounded to 64 KiB
combined stdout/stderr per CLI call, including diagnostics; one additional byte
can be read to detect overflow. Unicode replacement and JSON rendering can expand
that stored raw-byte prefix. A blocked client is killed/reaped, never confused with
container cleanup.

Work deadline remains 5 seconds including readiness/create/attach/exit inspection;
each CLI call, including attach, gets at most 2 seconds. Cleanup has the existing
separate bounded stop/rm/absence-query budgets. A late create ID gets only the
existing exact-identity recovery inspection, never permission to start or succeed.
Resource caps exclude daemon/controller overhead; scheduling and filesystem calls
are not hard-realtime bounded.

State remains `~/.local/state/mecode-engine1/`, shared with fixed smoke and other
worktrees under the same HOME; the legacy local latch also blocks. All `JUDGED`
outcomes clear the latch only after validated exit and exact-ID daemon absence;
wrong answers and caught exceptions are completed judgments, not engine failures.
Ambiguous execution or protocol outcomes retain the latch, even if cleanup was
confirmed. No retry/reset/name-delete is provided. Never change HOME/state_dir or
remove pending.json to make a failed trial pass. SIGINT enters existing cleanup;
callable integration must arrange SIGTERM -> controller._cancel on the main thread
if graceful TERM cleanup is needed. Otherwise abrupt caller death leaves the durable
latch, not an external watchdog. Never install global handlers implicitly in a library.

## Tests and known gaps

    python3 -B -W error -m unittest discover -s prototypes/docker-engine -v

Tests inject fake Docker and fake process/selector/pipe operations. A Popen guard
forbids accidental live launches. Fixed-wrapper unit tests execute only trusted
wrapper logic: the inner compile/exec are mocks, and solve is an inspected mock
callable. They do not compile or execute any submitted Python on the host. No
Docker/socket access, live submitted source, or image acquisition occurs in tests.

Most important gap: the wrapper and submission share one interpreter and UID.
Malicious source can inspect/mutate wrapper state or forge the known protocol and
answers. Neither the verdict nor the public cases are tamper-resistant. Python -I,
restricted filenames, and a separate globals dict are NOT Python security controls.
Container isolation is the intended host boundary, not a proven hostile-code service.
The current tests cannot prove actual CLI stdin delivery, live cgroup enforcement,
network/host denial, descendants gone, or behavior after controller death. Existing
coordinator fixed probes are context, not proof for this new leaf. Independent
Themis QA and relevant security acceptance remain open before broader integration.

Rollback: restore only this task's controller/docs delta and remove its new leaf,
tests and docs. Do not touch Prax's UI work or runtime recovery state. No host/global
configuration was changed. After a future live run, reconcile any pending state
before rollback; deleting source/state does not stop a container.
