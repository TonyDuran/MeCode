"""Linux trusted stdin adapter, self-authored by Talos; never executes source.

Only edited_runner.submit may execute submissions, through its Docker leaf.
This file and its two sibling modules must be installed as trusted app assets.
"""
import json
import math
from pathlib import Path
import signal
import sys

# -I excludes ambient PYTHONPATH and the script directory. Add only our trusted
# asset directory, never cwd, stdin, argv, or a renderer-controlled location.
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

INPUT_CAP = 100000  # 16 KiB source even when every byte becomes a JSON escape.
OUTPUT_CAP = 1024
SOURCE_CAP = 16384


class InputTimeout(Exception):
    pass


def _input_timeout(signum, frame):
    raise InputTimeout


def _unique(pairs):
    record = {}
    for key, value in pairs:
        if key in record:
            raise ValueError("duplicate key")
        record[key] = value
    return record


def unavailable(reason="engine_unavailable"):
    return {"status": "UNAVAILABLE", "verdict": None, "reason": reason, "elapsed_s": None}


def invalid():
    return {"status": "INVALID_INPUT", "verdict": None,
            "reason": "invalid_source_or_problem", "elapsed_s": None}


def project(result):
    # No source, paths, tracebacks, container IDs or daemon diagnostics cross IPC.
    if not isinstance(result, dict):
        return unavailable()
    elapsed = result.get("elapsed_s")
    if (result.get("status") == "JUDGED" and result.get("cleanup_confirmed") is True
            and result.get("verdict") in ("ACCEPTED", "WRONG_ANSWER", "RUNTIME_ERROR")
            and isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool)
            and math.isfinite(elapsed) and 0 <= elapsed <= 28):
        return {"status": "JUDGED", "verdict": result["verdict"], "reason": None,
                "elapsed_s": elapsed}
    if result.get("status") == "INVALID_INPUT":
        return invalid()
    return unavailable()


def read_request(stream):
    raw = stream.read(INPUT_CAP + 1)
    if len(raw) > INPUT_CAP:
        raise ValueError("input cap")
    request = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique)
    if (type(request) is not dict or set(request) != {"source", "problemId"}
            or request["problemId"] != "sum-array-v1" or type(request["source"]) is not str
            or len(request["source"]) > SOURCE_CAP
            or len(request["source"].encode("utf-8")) > SOURCE_CAP):
        raise ValueError("invalid input")
    return request


def main(argv=None, stdin=None, stdout=None):
    argv = sys.argv[1:] if argv is None else argv
    stdin = sys.stdin.buffer if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    result = unavailable()
    if sys.platform != "linux":
        result = unavailable("linux_only")
    elif argv:
        result = invalid()
    else:
        import controller
        import edited_runner
        previous_term = signal.signal(signal.SIGTERM, controller._cancel)
        previous_alarm = signal.signal(signal.SIGALRM, _input_timeout)
        try:
            signal.alarm(2)
            try:
                try:
                    request = read_request(stdin)
                finally:
                    signal.alarm(0)
            except (ValueError, UnicodeError, RecursionError):
                result = invalid()
            else:
                result = project(edited_runner.submit(request["source"], request["problemId"]))
        except InputTimeout:
            result = unavailable("input_timeout")
        except (Exception, KeyboardInterrupt):
            result = unavailable()
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGTERM, previous_term)
            signal.signal(signal.SIGALRM, previous_alarm)
    text = json.dumps(result, allow_nan=False, separators=(",", ":")) + "\n"
    assert len(text.encode("utf-8")) <= OUTPUT_CAP
    stdout.write(text)
    stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
