"""Trusted fixed-fixture judging experiment; not a security sandbox."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

CAP = 4096
FIXTURES = frozenset({"correct", "wrong", "exception", "malformed", "extra",
                      "boolean", "float", "empty_output", "invalid_utf8", "sleep_loop",
                      "oversize", "oversize_stderr", "exact_cap", "exact_cap_stderr"})
FIXTURE_FILE = Path(__file__).with_name("fixtures.py").resolve()


CASES = (("empty", []), ("singleton", [7]), ("positive", [1, 2, 3, 4]),
         ("negative", [-1, -2, -3]), ("mixed", [-100, 100, -3, 8]),
         ("duplicates", [5, 5, 5, -5]))


class Runner:
    def __init__(self):
        self.available = True
        self.failure_reason = None

    def _failure(self, fixture, nums, reason, start=None):
        self.available = False
        self.failure_reason = reason
        return {"fixture": fixture, "nums": nums,
                "verdict": "INTERNAL_RUNNER_FAILURE", "failure_reason": reason,
                "pid": None, "returncode": None, "cleanup_confirmed": None,
                "stdout": "", "stderr": "", "input_bytes": 0,
                "captured_bytes": {"stdout": 0, "stderr": 0},
                "observed_bytes": {"stdout": 0, "stderr": 0},
                "elapsed_s": 0.0 if start is None else time.monotonic() - start,
                "stop_reason": "internal_failure"}

    def _cleanup(self, proc):
        """Confirm direct trusted child is terminated and reaped, bounded wait."""
        try:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=2.0)
            return proc.returncode is not None
        except (OSError, subprocess.TimeoutExpired):
            return False

    def run_cases(self, fixture):
        records = []
        for name, nums in CASES:
            record = self.run(fixture, nums)
            record["case"] = name
            records.append(record)
            if not self.available:
                break
        return records

    def run(self, fixture, nums, budget=2.0):
        if not self.available:
            return self._failure(fixture, nums, self.failure_reason)
        if type(fixture) is not str or fixture not in FIXTURES:
            raise ValueError("unknown fixed fixture")
        if type(nums) is not list or len(nums) > 16:
            raise ValueError("nums must be a list of at most 16 integers")
        if any(type(n) is not int or not -100 <= n <= 100 for n in nums):
            raise ValueError("each value must be an exact int in [-100, 100]")
        if type(budget) not in (int, float) or not 0 < budget <= 2.0:
            raise ValueError("budget must be finite, positive and at most 2s")
        payload = json.dumps(nums).encode("utf-8")
        if len(payload) > CAP:
            raise ValueError("input exceeds cap")
        start = time.monotonic()
        try:
            proc = subprocess.Popen(
                [sys.executable, "-I", "-B", str(FIXTURE_FILE), fixture],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, start_new_session=True,
            )
        except OSError as exc:
            return self._failure(fixture, nums, "launch: " + type(exc).__name__, start)
        streams = {"stdout": bytearray(), "stderr": bytearray()}
        observed = {"stdout": 0, "stderr": 0}
        stopped = None
        capture_error = None
        sel = None
        try:
            sel = selectors.DefaultSelector()
            # <= PIPE_BUF on Linux, trusted fixtures; EOF after single document.
            proc.stdin.write(payload)
            proc.stdin.close()
            for name in streams:
                stream = getattr(proc, name)
                os.set_blocking(stream.fileno(), False)
                sel.register(stream, selectors.EVENT_READ, name)
            deadline = start + budget
            while sel.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    stopped = "timeout"
                    break
                for key, _ in sel.select(min(left, 0.05)):
                    chunk = os.read(key.fd, CAP)
                    if not chunk:
                        sel.unregister(key.fileobj)
                        continue
                    name = key.data
                    observed[name] += len(chunk)
                    remaining = CAP - len(streams[name])
                    streams[name].extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        stopped = "oversize"
                        break
                if stopped:
                    break
            if proc.poll() is None:
                if stopped:
                    proc.kill()
                try:
                    proc.wait(timeout=max(0.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    # Preserve a previously observed output violation.
                    stopped = stopped or "timeout"
                    proc.kill()
        except (OSError, ValueError) as exc:
            capture_error = "capture: " + type(exc).__name__
        finally:
            cleanup_start = time.monotonic()
            cleanup_confirmed = self._cleanup(proc)
            cleanup_elapsed = time.monotonic() - cleanup_start
            try:
                if sel is not None:
                    sel.close()
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    stream.close()
            except OSError as exc:
                capture_error = "close: " + type(exc).__name__
        output = bytes(streams["stdout"]).decode("utf-8", errors="replace")
        if not cleanup_confirmed:
            self.available = False
            self.failure_reason = "cleanup_unconfirmed"
            verdict = "INTERNAL_RUNNER_FAILURE"
        elif capture_error:
            self.available = False
            self.failure_reason = capture_error
            verdict = "INTERNAL_RUNNER_FAILURE"
        elif stopped == "timeout":
            verdict = "TIME_LIMIT"
        elif stopped == "oversize":
            verdict = "WRONG_ANSWER"
        elif proc.returncode != 0:
            verdict = "RUNTIME_ERROR"
        else:
            try:
                answer = json.loads(bytes(streams["stdout"]).decode("utf-8"))
                verdict = ("ACCEPTED" if type(answer) is int and answer == sum(nums)
                           else "WRONG_ANSWER")
            except (ValueError, UnicodeError):
                verdict = "WRONG_ANSWER"
        return {"fixture": fixture, "nums": nums, "verdict": verdict,
                "pid": proc.pid, "returncode": proc.returncode,
                "cleanup_confirmed": cleanup_confirmed, "cleanup_elapsed_s": cleanup_elapsed,
                "failure_reason": self.failure_reason, "run_budget_s": budget,
                "cleanup_budget_s": 2.0, "stdout": output,
                "stderr": bytes(streams["stderr"]).decode("utf-8", errors="replace"),
                "captured_bytes": {k: len(v) for k, v in streams.items()},
                "observed_bytes": observed, "input_bytes": len(payload),
                "elapsed_s": time.monotonic() - start, "stop_reason": stopped}
