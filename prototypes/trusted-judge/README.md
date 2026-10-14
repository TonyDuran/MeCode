# Trusted-fixture judge prototype

A local, standard-library-only experiment for `sum-array-v1`. Only the 14
inspected variants in `fixtures.py` run: correct/wrong sum, benign exception,
six invalid-output variants, benign sleep-loop, and stdout/stderr cap probes.
No user source, command, executable path or editor execution is accepted.
This is not a secure sandbox or a product execution service.

## Run

Requires ordinary CPython 3.10+ on a POSIX system supporting selector-driven
pipe reads and child-process reaping. Tested on Linux with Python 3.14.4;
other Python versions and macOS are not yet verified. Windows is unsupported.
No third-party packages, network access or installation are needed.

From the repository root:

    python3 -B -W error -m unittest discover -s prototypes/trusted-judge -v

Or from this directory:

    python3 -B -W error -m unittest -v

The runner launches `sys.executable`, the interpreter running the caller/tests,
with `-I -B`. Fixtures resolve relative to `runner.py`, not the working directory.
A relocation test copies source into a path containing spaces and executes the
original 16 tests from an unrelated directory, including timeout then clean run.
Temporary files use `TMPDIR` when supplied and are removed on completion. Tests
do not write evidence bundles or cached bytecode with these commands.

## Contract and verdicts

`Runner().run("correct", [1, 2, 3])` returns an observation dictionary;
`Runner().run_cases("correct")` executes six named fixed cases sequentially.
Inputs must be lists of at most 16 exact integers in [-100, 100]; empty is valid.
Unknown IDs, invalid input and nonpositive/nonfinite/>2-second budgets raise
`ValueError` before launch. A single JSON array is written, then stdin closes.
A valid answer is exactly one JSON integer matching the host sum, not bool/float.

- `ACCEPTED`: matching integer, successful exit.
- `WRONG_ANSWER`: invalid/mismatched output or stream overflow.
- `RUNTIME_ERROR`: other nonzero child exit.
- `TIME_LIMIT`: wall budget expires (sleep-loop test uses 0.5 seconds).
- `INTERNAL_RUNNER_FAILURE`: launch/capture failure or unconfirmed cleanup;
  that Runner becomes unavailable and never launches another fixture.

Each output stream retains at most 4096 bytes. A detected 4097th byte rejects
output; exactly 4096 bytes is permitted if the answer is correct. Diagnostic
stderr alone does not invalidate an otherwise correct answer. `observed_bytes`
counts bytes read before stopping, not necessarily all emitted bytes. Runtime
records contain fresh process IDs/timings for in-memory diagnostics only; no
historical records are included. Injected failures in tests are labeled and are
not claimed as real OS failures.

## Limits and provenance

Default wall budget is 2 seconds, followed by at most a 2-second direct-child
cleanup wait. OS launch/kill/close/scheduling are not hard realtime guarantees.
`cleanup_elapsed_s` measures final confirmation, not total kill-to-reap latency.
The trusted fixtures spawn no descendants. Cleanup/reaping is direct-child only;
PID absence checks can conservatively fail if a PID is reused.

Processes retain host privileges, environment, filesystem, network and memory
access. `-I`, a new session and an allowlist are not security boundaries. Local
fixture modification is not defended against. No CPU/memory isolation, hostile
code, concurrent scheduling, automatic recovery from uncertain cleanup, general
parser-depth resilience, bundled runtime or cross-platform product is claimed.
Never connect learner/editor code to this runner.

Curated from the accepted planning PoC: runner behavior unchanged except using
the launch interpreter; fixtures and original 16 runner tests retained verbatim.
Additional tests cover interpreter selection, relocation, literal case oracles,
answer comparison at the cap and fake cleanup-error branches. Evidence recorder,
historical provenance tests/bundles and planning documents are intentionally
excluded. New portability changes still require Talos review and independent
Themis QA on the exact working tree. No commit, publication or approval implied.
