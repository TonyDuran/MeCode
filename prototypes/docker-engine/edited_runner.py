"""Experimental sum-array-v1 edited Python adapter; self-authored by Talos.

Only Docker executes submitted source. No host fallback, browser or service.
The fixed wrapper shares a Python process with the submission: verdicts are NOT
resistant to deliberate judge tampering. See EDITED-RUNNER.md before live use.
"""
import json
import time

import controller as c

PROBLEM_ID = "sum-array-v1"
SOURCE_CAP = c.INPUT_CAP
# Literal oracles from trusted-judge/test_contract.py; no host fixture execution.
CASES = (("empty", (), 0), ("singleton", (7,), 7),
         ("positive", (1, 2, 3, 4), 10), ("negative", (-1, -2, -3), -6),
         ("mixed", (-100, 100, -3, 8), 5), ("duplicates", (5, 5, 5, -5), 10))

# Trusted, fixed program in argv. Source travels only as bounded UTF-8 stdin.
# No traceback or arbitrary repr/JSON serialization of learner-returned objects.
WRAPPER = '''import json, sys
source = sys.stdin.buffer.read(16385)
if len(source) > 16384:
    raise SystemExit(64)
try:
    namespace = {"__name__": "__submission__"}
    exec(compile(source.decode("utf-8"), "<submission>", "exec"), namespace)
    solve = namespace["solve"]
    answers = []
    for nums in ([], [7], [1, 2, 3, 4], [-1, -2, -3], [-100, 100, -3, 8], [5, 5, 5, -5]):
        value = solve(nums)
        answers.append(value if type(value) is int and -1600 <= value <= 1600 else None)
    result = {"answers": answers}
except BaseException:
    result = {"error": "exception"}
sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\\n")
'''


def _unique_object(pairs):
    record = {}
    for key, value in pairs:
        if key in record:
            raise ValueError("duplicate protocol key")
        record[key] = value
    return record


class _Submission(c.Controller):
    SUCCESS_STATUS = "JUDGED"

    def __init__(self, transport, payload, state_dir, clock):
        super().__init__(transport, state_dir, clock=clock)
        self.payload = payload

    def _create_args(self, name):
        baseline = c.create_args(name)
        # Preserve the reviewed envelope verbatim; replace only fixed command,
        # and keep stdin open. No TTY (would merge streams/change byte framing).
        return (*baseline[:-len(c.COMMAND)-1], "--interactive", c.IMAGE,
                "-I", "-B", "-c", WRAPPER)

    def _start(self, container_id, deadline):
        return self._call(("start", "--attach", "--interactive", container_id),
                          deadline, input_bytes=self.payload)

    def _judge(self, output):
        try:
            record = json.loads(output.decode("utf-8"), object_pairs_hook=_unique_object)
        except (ValueError, UnicodeError, RecursionError):
            raise c.Failure("invalid_judge_protocol") from None
        if record == {"error": "exception"}:
            verdict = "RUNTIME_ERROR"
        elif (isinstance(record, dict) and set(record) == {"answers"}
              and isinstance(record["answers"], list) and len(record["answers"]) == len(CASES)
              and all(value is None or type(value) is int for value in record["answers"])):
            verdict = ("ACCEPTED" if record["answers"] == [case[2] for case in CASES]
                       else "WRONG_ANSWER")
        else:
            raise c.Failure("invalid_judge_protocol")
        return {"status": self.SUCCESS_STATUS, "verdict": verdict}


class Runner:
    """Trusted caller owns transport/state/clock; none are submission inputs.

    Each call has immutable payload and its own controller; shared durable flock
    serializes submissions with the fixed-smoke runner, including other processes.
    Do not change state_dir/HOME to bypass a retained latch.
    """

    def __init__(self, transport=None, state_dir=c.STATE_DIR, clock=time.monotonic):
        self.transport = transport if transport is not None else c.DockerCLI()
        self.state_dir = state_dir
        self.clock = clock

    def submit(self, source, problem_id):
        invalid = {"status": "INVALID_INPUT", "verdict": None, "problem_id": PROBLEM_ID,
                   "reason": "invalid_source_or_problem", "stage": "validation",
                   "container_id": None, "cleanup_confirmed": None, "stdout": "",
                   "stderr": "", "truncated": False, "daemon_warnings": None, "elapsed_s": 0.0}
        if (type(problem_id) is not str or problem_id != PROBLEM_ID
                or type(source) is not str or len(source) > SOURCE_CAP):
            return invalid
        try:
            payload = source.encode("utf-8")
        except UnicodeEncodeError:
            return invalid
        if len(payload) > SOURCE_CAP:
            return invalid
        result = _Submission(self.transport, payload, self.state_dir, self.clock).run()
        result["problem_id"] = PROBLEM_ID
        # Never leak an apparent verdict when cleanup or latch clearance failed.
        if result["status"] != "JUDGED":
            result["verdict"] = None
        return result


def submit(source, problem_id):
    """Narrow integration callable. Live invocation uses the actual Docker CLI."""
    return Runner().submit(source, problem_id)
