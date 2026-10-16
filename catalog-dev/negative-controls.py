#!/usr/bin/env python3
"""Negative controls for the catalog gate: each deliberate corruption, applied to a THROWAWAY copy, must make
`catalog.py check` exit non-zero with the NAMED message. If any control passes silently the gate is not trustworthy.
Usage: python3 catalog-dev/negative-controls.py   (exit 0 only when every control went red as expected)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def fresh_copy():
    d = tempfile.mkdtemp(prefix="catneg-", dir=os.environ.get("TMPDIR"))
    shutil.copytree(HERE, os.path.join(d, "catalog-dev"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(ROOT, "packs"), os.path.join(d, "packs"))
    return d


def edit(path, fn):
    with open(path, encoding="utf8") as f:
        s = f.read()
    t = fn(s)
    assert t != s, f"control did not change {path}"
    with open(path, "w", encoding="utf8") as f:
        f.write(t)


def tamper_expected(s):
    j = json.loads(s)
    t = j["problems"][0]["tests"][-1]
    t["expected"] = "123456789\n"
    return json.dumps(j, indent=2, ensure_ascii=False) + "\n"


def drop_problem(s):
    j = json.loads(s)
    j["problems"].pop()
    return json.dumps(j, indent=2, ensure_ascii=False) + "\n"


def relabel_pattern(s):
    j = json.loads(s)
    j["problems"][0]["patterns"] = ["greedy"]
    return json.dumps(j, indent=2, ensure_ascii=False) + "\n"


def relicense(s):
    return s.replace('"CC0-1.0"', '"All-Rights-Reserved"', 1)


CONTROLS = [
    ("tampered expected answer", "packs/mecode-patterns.json", tamper_expected, "stale generated artifact"),
    ("a pattern problem silently dropped", "packs/mecode-patterns.json", drop_problem, "stale generated artifact"),
    ("pattern relabelled outside the T01 distribution", "packs/mecode-patterns.json", relabel_pattern, "stale generated artifact"),
    ("licence changed away from CC0", "packs/mecode-patterns.json", relicense, "stale generated artifact"),
    ("wrong baseline made identical to the reference (not discriminating)", "catalog-dev/problems/p00_core.py", lambda s: s.replace("wrong=w_beacon,", "wrong=s_beacon,"), "wrong baseline fails no check"),
    (
        "reference given an off-by-one bug",
        "catalog-dev/problems/p01_batch1.py",
        lambda s: s.replace("best = max(best, hi - lo + 1)\n    return f\"{best}\\n\"\n\n\ndef b_calm", "best = max(best, hi - lo)\n    return f\"{best}\\n\"\n\n\ndef b_calm"),
        "disagrees",
    ),
    # ---- T18 DOMAIN controls: the failure must be the NAMED domain error (a stale/missing artifact alone does not satisfy `want`) ----
    (
        "charging-loop: old ambiguous seed-1 input (valid starts 4 and 5) stored as a fixture",
        "catalog-dev/problems/p03_batch3.py",
        lambda s: s.replace(r'("1\n4\n5\n", "-1")', r'("6\n1 1 2 4 2 5\n1 2 2 5 1 2\n", "4")'),
        "DOMAIN violation in stored case check-edge-2: charging-loop start is not unique: valid starts [4, 5]",
    ),
    (
        "charging-loop: old ambiguous seed-4 input (valid starts 0, 2, 3) stored as a fixture",
        "catalog-dev/problems/p03_batch3.py",
        lambda s: s.replace(r'("5\n1 2 3 4 5\n3 4 5 1 2\n", "3")', r'("5\n6 1 5 4 1\n2 4 5 0 5\n", "0")'),
        "DOMAIN violation in stored case check-edge-4: charging-loop start is not unique: valid starts [0, 2, 3]",
    ),
    (
        "charging-loop: generator stops redrawing ambiguous inputs",
        "catalog-dev/problems/p03_batch3.py",
        lambda s: s.replace("if len(charging_starts(s)) <= 1:", "if True:"),
        "DOMAIN violation in extra seeded case",
    ),
    (
        "coupled-cars: n=3 k=5 (violates k <= n+1) stored as the edge fixture",
        "catalog-dev/problems/p04_batch4.py",
        lambda s: s.replace(r'("3 4\n1 2 3\n", "1 2 3")', r'("3 5\n1 2 3\n", "1 2 3")'),
        "coupled-cars k=5 violates 1 <= k <= n+1 (n=3)",
    ),
    (
        "cheapest-route: a self-loop road (u == v) stored as a fixture",
        "catalog-dev/problems/p04_batch4.py",
        lambda s: s.replace(r'("2 0\n", "-1")', r'("2 1\n1 1 5\n", "-1")'),
        "road 1 is a self-loop (u == v == 1) violating u != v",
    ),
    (
        "cheapest-route: large generator stops rejecting equal endpoints",
        "catalog-dev/problems/p04_batch4.py",
        lambda s: s.replace("        if v != u:\n            return f\"{u} {v}", "        if True:\n            return f\"{u} {v}"),
        "DOMAIN violation in stored case check-large: cheapest-route road",
    ),
]


def main():
    bad = 0
    for name, rel, fn, want in CONTROLS:
        d = fresh_copy()
        try:
            edit(os.path.join(d, rel), fn)
            r = subprocess.run([sys.executable, os.path.join(d, "catalog-dev", "catalog.py"), "check"], capture_output=True, text=True, timeout=250)
            out = r.stdout + r.stderr
            red = r.returncode != 0 and want in out
            print(f"{'RED (expected)' if red else 'NOT RED - GATE IS BROKEN'}: {name} -> exit {r.returncode}, message contains {want!r}: {want in out}")
            bad += 0 if red else 1
        finally:
            shutil.rmtree(d, ignore_errors=True)
    # positive control: the untouched copy is GREEN
    d = fresh_copy()
    try:
        r = subprocess.run([sys.executable, os.path.join(d, "catalog-dev", "catalog.py"), "check"], capture_output=True, text=True, timeout=250)
        print(f"GREEN (expected): untouched copy -> exit {r.returncode}")
        bad += 0 if r.returncode == 0 else 1
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("negative controls:", "ALL BEHAVED" if not bad else f"{bad} FAILED")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
