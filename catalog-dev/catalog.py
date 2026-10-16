#!/usr/bin/env python3
"""MeCode catalog development workflow (trusted DEV asset; never part of a pack, never run on learner code).

  python3 catalog-dev/catalog.py build     regenerate packs/*.json, catalog-dev/refs/*.py, COVERAGE.{json,md} deterministically
  python3 catalog-dev/catalog.py verify    execute every reference on every stored case + brute/differential + wrong baselines
  python3 catalog-dev/catalog.py check     verify AND assert the committed artifacts equal a fresh build (CI gate)

A brute oracle returns None for inputs too big for it (that case is then simply not brute-verified).
"""

import hashlib
import importlib.util
import inspect
import json
import os
import signal
import subprocess
import sys
import textwrap
from collections import Counter

signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("too slow")))

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import lib  # noqa: E402

PACK_NEW = "mecode-patterns"
EXPECT_TOTAL = 48
LIMITS = {"stdin": 64 * 1024, "expected": 64 * 1024, "tests": 64}
HEADER = (
    "import sys, heapq, bisect, math, itertools, functools\n"
    "from collections import *\n"
    "from itertools import *\n\n" + "".join(textwrap.dedent(inspect.getsource(f)) + "\n" for f in (lib.ints, lib.row, lib.fmt))
)


def load():
    lib.REG.clear()
    d = os.path.join(HERE, "problems")
    for f in sorted(os.listdir(d)):
        if f.startswith("p") and f.endswith(".py"):
            spec = importlib.util.spec_from_file_location(f[:-3], os.path.join(d, f))
            m = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(m)
    ids = [p["id"] for p in lib.REG]
    assert len(ids) == len(set(ids)), "duplicate problem ids"
    return list(lib.REG)


def norm(s):
    return s if s.endswith("\n") else s + "\n"


def legacy_problems():
    with open(os.path.join(HERE, "legacy", "core-v1.json"), encoding="utf8") as f:
        return json.load(f)


def assemble(p, legacy_by_id):
    """Build the pack-problem dict (without contentHash) for registry entry p."""
    gen_tests = []
    used = {s for s, _, _ in p.get("ex", [])} | {s for s, _ in p.get("known", [])} | {t["stdin"] for q in legacy_by_id.get(p["id"], {}).get("tests", []) for t in [q]}
    for i, (stdin, expected) in enumerate(p.get("known", []), 1):
        gen_tests.append({"id": f"check-edge-{i}", "kind": "check", "stdin": stdin, "expected": norm(expected)})
    for i in range(1, lib.SEEDED_CASES + 1):
        for salt in range(50):  # deterministic re-draw when a seeded case repeats an existing input
            stdin = p["gen"](lib.rng_for(p["id"], f"seed{i}" + ("" if not salt else f"-{salt}")), i)
            if stdin not in used:
                break
        used.add(stdin)
        gen_tests.append({"id": f"check-seed-{i}", "kind": "check", "stdin": stdin, "expected": norm(p["solve"](stdin))})
    if p.get("big"):
        stdin = p["big"](lib.rng_for(p["id"], "big"))
        gen_tests.append({"id": "check-large", "kind": "check", "stdin": stdin, "expected": norm(p["solve"](stdin))})
    if p["id"] in legacy_by_id:  # existing original problem: keep fields, IDs, tests, starters; append checks; fill missing starters
        old = json.loads(json.dumps(legacy_by_id[p["id"]]))
        for k, v in lib.starters(old["inputFormat"]).items():
            old["starters"].setdefault(k, v)
        old["tests"] = old["tests"] + gen_tests
        return old
    tests = []
    for i, (stdin, expected, expl) in enumerate(p["ex"], 1):
        tests.append({"id": f"example-{i}", "kind": "example", "stdin": stdin, "expected": norm(expected), "explanation": expl})
    return {
        "id": p["id"],
        "title": p["title"],
        "difficulty": p["diff"],
        "patterns": [p["pat"]],
        "statement": p["st"],
        "inputFormat": p["inf"],
        "outputFormat": p["outf"],
        "constraints": p["cons"],
        "comparison": "tokens",
        "starters": lib.starters(p["inf"]),
        "tests": tests + gen_tests,
    }


def dumps(o):
    return json.dumps(o, indent=2, ensure_ascii=False) + "\n"


def ref_source(p, which="solve"):
    fn = p[which]
    helpers = "".join(textwrap.dedent(inspect.getsource(h)) + "\n\n" for h in p.get("helpers", []))
    dep = textwrap.dedent(inspect.getsource(p["solve"])) + "\n\n" if which != "solve" else ""  # the wrong baselines may delegate to the reference
    return HEADER + "\n" + helpers + dep + textwrap.dedent(inspect.getsource(fn)) + f"\n\nsys.stdout.write({fn.__name__}(sys.stdin.read()))\n"


def build_all(regs):
    leg = legacy_problems()
    legacy_by_id = {q["id"]: q for q in leg["problems"]}
    core_ids = [q["id"] for q in leg["problems"]]
    by_id = {p["id"]: p for p in regs}
    core = dict(leg)
    core["problems"] = [assemble(by_id[i], legacy_by_id) for i in core_ids]
    new = {
        "schemaVersion": 1,
        "id": PACK_NEW,
        "title": "MeCode pattern catalog (original)",
        "provenance": {"kind": "original", "authors": ["MeCode contributors"], "license": "CC0-1.0", "sources": []},
        "problems": [assemble(p, legacy_by_id) for p in regs if p["id"] not in legacy_by_id],
    }
    files = {"packs/core.json": dumps(core), f"packs/{PACK_NEW}.json": dumps(new)}
    for p in regs:
        files[f"catalog-dev/refs/{p['id']}.py"] = ref_source(p)
        files[f"catalog-dev/wrong/{p['id']}.py"] = ref_source(p, "wrong")
    return files, core, new


def tokens(s):
    return s.split()


def run_ref(path, stdin):
    r = subprocess.run([sys.executable, "-I", path], input=stdin, capture_output=True, text=True, timeout=30)
    return r.returncode, r.stdout, r.stderr


def verify(regs, core, new):
    errs = []
    report = {}
    allp = [(core["id"], q) for q in core["problems"]] + [(new["id"], q) for q in new["problems"]]
    by_id = {p["id"]: p for p in regs}
    titles, statements = set(), set()
    for pack_id, q in allp:
        pid = q["id"]
        p = by_id[pid]
        tests = q["tests"]
        ex = [t for t in tests if t["kind"] == "example"]
        ck = [t for t in tests if t["kind"] == "check"]

        def e(m, pid=pid):
            errs.append(f"{pid}: {m}")

        if len(ex) < 2:
            e(f"{len(ex)} examples (<2)")
        if len(ck) < 8:
            e(f"{len(ck)} checks (<8)")
        if len(tests) > LIMITS["tests"]:
            e("too many tests")
        if len({t["stdin"] for t in tests}) != len(tests):
            e("duplicate stdin among tests")
        for t in tests:
            if len(t["stdin"].encode()) > LIMITS["stdin"] or len(t["expected"].encode()) > LIMITS["expected"]:
                e(f"test {t['id']} over size cap")
            if not t["expected"].strip():
                e(f"test {t['id']} has empty expected")
        if not set(q["patterns"]) <= set(lib.PATTERN_SLUGS):
            e(f"pattern not in registry: {q['patterns']}")
        if set(q["starters"]) != {"python", "javascript", "cpp", "c"}:
            e("starters must cover all four languages")
        if q["title"] in titles or q["statement"] in statements:
            e("duplicate title/statement")
        titles.add(q["title"])
        statements.add(q["statement"])
        if q["difficulty"] not in ("easy", "medium", "hard") or not q["constraints"] or q["comparison"] != "tokens":
            e("bad difficulty/constraints/comparison")
        # 0. authoring-time DOMAIN validation of every stored input and the extra seeded differential inputs; a domain
        #    violation is reported by name and the case is excluded from answer comparison (oracle agreement on an
        #    out-of-domain input proves nothing).
        dom_bad = set()
        if p.get("dom"):
            for t in tests:
                for m in p["dom"](t["stdin"]):
                    e(f"DOMAIN violation in stored case {t['id']}: {m}")
                    dom_bad.add(t["id"])
            for i in range(lib.EXTRA_DIFFERENTIAL):
                for m in p["dom"](p["gen"](lib.rng_for(pid, f"diff{i}"), 1 + i % 6)):
                    e(f"DOMAIN violation in extra seeded case {i}: {m}")
        # 1. the standalone generated reference program, really executed on every stored case
        refpath = os.path.join(HERE, "refs", f"{pid}.py")
        ref_ok = 0
        for t in tests:
            if t["id"] in dom_bad:
                continue
            rc, out, err = run_ref(refpath, t["stdin"])
            if rc != 0 or tokens(out) != tokens(t["expected"]):
                e(f"reference {'crashed' if rc else 'disagrees'} on {t['id']}: rc={rc} got={out[:60]!r} want={t['expected'][:60]!r} {err[-200:]}")
            else:
                ref_ok += 1
        # 2. independent brute-force oracle on stored cases and on extra seeded small cases
        brute_stored, brute_extra = 0, 0
        if p.get("brute"):
            for t in tests:
                if t["id"] in dom_bad:
                    continue
                b = p["brute"](t["stdin"])
                if b is None:
                    continue
                if tokens(b) != tokens(t["expected"]):
                    e(f"brute disagrees with stored expected on {t['id']}")
                brute_stored += 1
            for i in range(lib.EXTRA_DIFFERENTIAL):
                s = p["gen"](lib.rng_for(pid, f"diff{i}"), 1 + i % 6)
                b = p["brute"](s)
                if b is not None:
                    if tokens(b) != tokens(p["solve"](s)):
                        e(f"brute/solve differ on extra seeded case {i}")
                    brute_extra += 1
        # 3. deliberately wrong baseline must fail discriminating checks
        wrong_fail = []
        wrong_pass_examples = True
        for t in tests:
            signal.alarm(2)
            try:
                w = p["wrong"](t["stdin"])
            except BaseException as ex_:  # a crash or a >2 s run (too slow) counts as failing the case
                w = f"<crash {type(ex_).__name__}>"
            finally:
                signal.alarm(0)
            if tokens(w) != tokens(t["expected"]):
                wrong_fail.append(t["id"])
                if t["kind"] == "example":
                    wrong_pass_examples = False
        if not any(i.startswith("check") and i != "check-large" for i in wrong_fail):
            e("wrong baseline fails no check (not discriminating)")
        # 4. the starter placeholder must not pass everything
        if all(tokens(t["expected"]) == ["0"] for t in tests):
            e("starter placeholder would pass all tests")
        hand = [t["id"] for t in tests if not t["id"].startswith(("check-seed", "check-large"))]
        report[pid] = {
            "pack": pack_id,
            "title": q["title"],
            "difficulty": q["difficulty"],
            "patterns": q["patterns"],
            "examples": len(ex),
            "checks": len(ck),
            "tests": len(tests),
            "referenceExecutedOk": ref_ok,
            "handAnsweredCases": len(hand),
            "bruteOracleStored": brute_stored,
            "bruteOracleExtraSeeded": brute_extra,
            "wrongBaselineFails": wrong_fail,
            "wrongBaselinePassesAllExamples": wrong_pass_examples,
            "referenceFile": f"catalog-dev/refs/{pid}.py",
        }
    dist = Counter(pt for _, q in allp for pt in q["patterns"])
    for pk in (core, new):
        pv = pk["provenance"]
        if pv["kind"] != "original" or pv["license"] != "CC0-1.0" or pv["sources"]:
            errs.append(f"pack {pk['id']}: provenance must be original / CC0-1.0 / no external sources")
    want = {s: n for s, _, n in lib.PATTERNS}
    if len(allp) != EXPECT_TOTAL:
        errs.append(f"total problems {len(allp)} != {EXPECT_TOTAL}")
    if dict(dist) != want:
        errs.append(f"pattern distribution {dict(dist)} != {want}")
    summary = {
        "total": len(allp),
        "patterns": len(dist),
        "perPattern": {s: dist.get(s, 0) for s, _, _ in lib.PATTERNS},
        "perDifficulty": dict(Counter(q["difficulty"] for _, q in allp)),
        "totalTests": sum(r["tests"] for r in report.values()),
        "totalExamples": sum(r["examples"] for r in report.values()),
        "totalChecks": sum(r["checks"] for r in report.values()),
        "problemsWithBruteOracle": sum(1 for r in report.values() if r["bruteOracleStored"] or r["bruteOracleExtraSeeded"]),
        "problemsWithoutBruteOracle": sorted(k for k, r in report.items() if not (r["bruteOracleStored"] or r["bruteOracleExtraSeeded"])),
        "wrongBaselinesDiscriminating": sum(1 for r in report.values() if any(i.startswith("check") for i in r["wrongBaselineFails"])),
    }
    return errs, {"summary": summary, "problems": report}


def coverage_md(idx):
    s = idx["summary"]
    L = ["# MeCode catalog coverage index (generated by `python3 catalog-dev/catalog.py build`; do not edit)", ""]
    L.append(f"Problems: {s['total']} across {s['patterns']} patterns; tests: {s['totalTests']} ({s['totalExamples']} examples + {s['totalChecks']} checks).")
    L.append(f"Difficulty: {s['perDifficulty']}")
    L.append(f"Problems with a brute/differential oracle: {s['problemsWithBruteOracle']}; without: {s['problemsWithoutBruteOracle'] or 'none'}")
    L.append(f"Wrong baselines failing at least one check: {s['wrongBaselinesDiscriminating']}/{s['total']}")
    L.append("")
    L.append("| pattern | problems |")
    L.append("|---|---|")
    for slug, label, n in lib.PATTERNS:
        ids = [k for k, r in idx["problems"].items() if slug in r["patterns"]]
        L.append(f"| {slug} ({label}) | {len(ids)}/{n}: {', '.join(ids)} |")
    L.append("")
    L.append("| problem | pack | difficulty | ex | chk | brute (stored/extra) | wrong fails |")
    L.append("|---|---|---|---|---|---|---|")
    for k, r in idx["problems"].items():
        L.append(f"| {k} | {r['pack']} | {r['difficulty']} | {r['examples']} | {r['checks']} | {r['bruteOracleStored']}/{r['bruteOracleExtraSeeded']} | {len(r['wrongBaselineFails'])} |")
    return "\n".join(L) + "\n"


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    regs = load()
    files, core, new = build_all(regs)
    if cmd == "build":
        os.makedirs(os.path.join(HERE, "refs"), exist_ok=True)
        os.makedirs(os.path.join(HERE, "wrong"), exist_ok=True)
        for rel, text in files.items():
            with open(os.path.join(ROOT, rel), "w", encoding="utf8", newline="\n") as f:
                f.write(text)
    errs, idx = verify(regs, core, new)
    files["catalog-dev/COVERAGE.json"] = dumps(idx)
    files["catalog-dev/COVERAGE.md"] = coverage_md(idx)
    if cmd == "build":
        for rel in ("catalog-dev/COVERAGE.json", "catalog-dev/COVERAGE.md"):
            with open(os.path.join(ROOT, rel), "w", encoding="utf8", newline="\n") as f:
                f.write(files[rel])
    if cmd == "check":
        for rel, text in files.items():
            try:
                with open(os.path.join(ROOT, rel), encoding="utf8") as f:
                    if f.read() != text:
                        errs.append(f"stale generated artifact (run build): {rel}")
            except FileNotFoundError:
                errs.append(f"missing generated artifact: {rel}")
        for sub in ("refs", "wrong"):
            have = set(os.listdir(os.path.join(HERE, sub))) if os.path.isdir(os.path.join(HERE, sub)) else set()
            if have != {f"{p['id']}.py" for p in regs}:
                errs.append(f"catalog-dev/{sub} does not match the registry")
    print(json.dumps(idx["summary"], indent=1))
    print("packs sha256:", hashlib.sha256((files["packs/core.json"] + files[f"packs/{PACK_NEW}.json"]).encode()).hexdigest())
    if errs:
        print(f"FAIL: {len(errs)} problem(s)")
        for x in errs[:60]:
            print(" -", x)
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
