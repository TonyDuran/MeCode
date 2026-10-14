"""Inspected team fixtures only. Never accepts source or a command/path."""
import json
import sys
import time


def solve(nums):
    return sum(nums)


if __name__ == "__main__":
    fixture = sys.argv[1]
    if fixture not in {"correct", "wrong", "exception", "malformed", "extra",
                       "boolean", "float", "empty_output", "invalid_utf8", "sleep_loop",
                       "oversize", "oversize_stderr", "exact_cap", "exact_cap_stderr"} or len(sys.argv) != 2:
        raise ValueError("unknown fixed fixture")
    nums = json.load(sys.stdin)
    if fixture == "sleep_loop":
        while True:
            time.sleep(0.1)
    if fixture == "exception":
        raise RuntimeError("benign fixture exception")
    answer = solve(nums)
    if fixture == "wrong":
        answer += 1
    if fixture in {"oversize", "exact_cap"}:
        # Finite, tiny cap probe: valid answer plus JSON whitespace.
        size = 4097 if fixture == "oversize" else 4096
        sys.stdout.write("1" + " " * (size - 1))
    elif fixture in {"oversize_stderr", "exact_cap_stderr"}:
        size = 4097 if fixture == "oversize_stderr" else 4096
        sys.stderr.write("x" * size)
        print(json.dumps(answer))
    elif fixture == "malformed":
        print("not-json")
    elif fixture == "extra":
        print(json.dumps(answer))
        print(json.dumps(answer))
    elif fixture == "boolean":
        print("true")
    elif fixture == "float":
        print(json.dumps(float(answer)))
    elif fixture == "empty_output":
        pass
    elif fixture == "invalid_utf8":
        sys.stdout.buffer.write(b"1\xff")
    else:
        print(json.dumps(answer))
