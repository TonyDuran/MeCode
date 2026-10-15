"""MeCode engine runner: JSON-lines on stdin/stdout. One run per process. Never receives expected answers."""
import json, os, selectors, signal, subprocess, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from adapters import ADAPTERS, expand  # noqa: E402

WORKDIR = os.environ.get("MECODE_WORKDIR", "/work")
MAX_FRAME = 8 * 1024 * 1024
OUT = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")  # protocol channel
os.dup2(2, 1)  # anything else printing to fd 1 goes to stderr, not the protocol


def emit(frame):
    frame["v"] = 1
    OUT.write(json.dumps(frame, separators=(",", ":")) + "\n")
    OUT.flush()


def read_text(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def controls():
    return {"memoryMax": read_text("/sys/fs/cgroup/memory.max"), "pidsMax": read_text("/sys/fs/cgroup/pids.max"),
            "cpuMax": read_text("/sys/fs/cgroup/cpu.max"), "uid": os.getuid()}


def version(argv):
    try:
        p = subprocess.run(argv, capture_output=True, timeout=10, text=True)
        if p.returncode == 0:
            return (p.stdout or p.stderr).splitlines()[0].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def kill_group(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_proc(argv, stdin_bytes, timeout_s, cap):
    """Run argv; bounded output; kills the whole process group on timeout/overflow."""
    t0 = time.monotonic()
    try:
        p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=WORKDIR,
                             start_new_session=True, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/tmp"})
    except OSError as e:
        return {"stdout": "", "stderr": f"cannot start {argv[0]}: {e.strerror}", "exitCode": 127, "signal": None, "elapsedMs": 0, "timedOut": False, "outputLimit": False}

    def feed():
        try:
            p.stdin.write(stdin_bytes)
        except OSError:
            pass
        finally:
            try:
                p.stdin.close()
            except OSError:
                pass

    threading.Thread(target=feed, daemon=True).start()
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ, "o")
    sel.register(p.stderr, selectors.EVENT_READ, "e")
    bufs = {"o": bytearray(), "e": bytearray()}
    timed_out = overflow = False
    while sel.get_map():
        left = timeout_s - (time.monotonic() - t0)
        if left <= 0:
            timed_out = True
            kill_group(p)
            break
        for key, _ in sel.select(min(left, 0.05)):
            chunk = os.read(key.fileobj.fileno(), 65536)
            if not chunk:
                sel.unregister(key.fileobj)
                continue
            bufs[key.data] += chunk
            if len(bufs["o"]) + len(bufs["e"]) > cap:
                overflow = True
        if overflow:
            kill_group(p)
            break
    kill_group(p)  # reap stragglers in the group
    try:
        rc = p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        rc = None
    elapsed = int((time.monotonic() - t0) * 1000)
    sig = -rc if isinstance(rc, int) and rc < 0 else None
    # combined byte budget: stdout first, stderr gets the remainder; decoded text is re-bounded in BYTES
    ob = bytes(bufs["o"][:cap])
    eb = bytes(bufs["e"][:max(0, cap - len(ob))])
    if len(bufs["o"]) + len(bufs["e"]) > cap:
        overflow = True

    def dec(b, room):
        t = b.decode("utf-8", "replace")
        e = t.encode("utf-8")
        return t if len(e) <= room else e[:room].decode("utf-8", "ignore")

    so = dec(ob, cap)
    se = dec(eb, max(0, cap - len(so.encode("utf-8"))))
    return {"stdout": so, "stderr": se, "exitCode": None if timed_out or overflow or sig else rc,
            "signal": signal.Signals(sig).name if sig else None, "elapsedMs": elapsed, "timedOut": timed_out, "outputLimit": overflow}


def main():
    langs = []
    for lid, a in ADAPTERS.items():
        v = version(a["version"])
        if v:
            langs.append({"id": lid, "version": v})
    emit({"type": "ready", "languages": langs, "controls": controls()})
    line = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not line or len(line) > MAX_FRAME:
        emit({"type": "error", "message": "missing or oversized run frame"})
        return 2
    try:
        req = json.loads(line)
        assert req["v"] == 1 and req["type"] == "run"
        job, lang, src, cases, lim = req["jobId"], req["language"], req["source"], req["cases"], req["limits"]
        ad = ADAPTERS[lang]
        assert isinstance(src, str) and isinstance(cases, list)
        case_s, comp_s, job_s, cap = lim["caseMs"] / 1000, lim["compileMs"] / 1000, lim["jobMs"] / 1000, lim["outputBytes"]
        agg_cap = lim.get("aggregateBytes", 1024 * 1024)
        assert all(isinstance(lim[k], int) and not isinstance(lim[k], bool) and lim[k] > 0 for k in ("caseMs", "compileMs", "jobMs", "outputBytes"))
        assert isinstance(agg_cap, int) and 0 < agg_cap <= 8 * 1024 * 1024
        assert all(isinstance(c, dict) and isinstance(c.get("id"), str) and isinstance(c.get("stdin"), str) for c in cases)
    except (ValueError, KeyError, AssertionError, TypeError):
        emit({"type": "error", "message": "invalid run frame"})
        return 2
    t_job = time.monotonic()
    os.makedirs(WORKDIR, exist_ok=True)
    with open(os.path.join(WORKDIR, ad["source"]), "w", encoding="utf-8") as f:
        f.write(src)
    comp = expand(ad["compile"], WORKDIR)
    if comp:
        # compile consumes the WHOLE-JOB budget too: never longer than what is left of jobMs
        comp_budget = min(comp_s, job_s)
        r = run_proc(comp, b"", comp_budget, cap)
        ok = (not r["timedOut"]) and (not r["outputLimit"]) and r["exitCode"] == 0
        out = (r["stdout"] + r["stderr"]).encode("utf-8")[:cap].decode("utf-8", "ignore")
        emit({"type": "compile", "jobId": job, "ok": ok, "timedOut": r["timedOut"], "output": out, "elapsedMs": r["elapsedMs"],
              "limit": "job" if r["timedOut"] and job_s <= comp_s else ("compile" if r["timedOut"] else None)})
        if not ok:
            emit({"type": "done", "jobId": job, "reason": "compile-error"})
            return 0
    reason, total = "complete", 0
    run = expand(ad["run"], WORKDIR)
    for c in cases:
        left = job_s - (time.monotonic() - t_job)
        if left <= 0:
            reason = "job-timeout"
            break
        room = agg_cap - total
        r = run_proc(run, c["stdin"].encode("utf-8"), min(case_s, left), min(cap, max(room, 0)))
        total += len(r["stdout"].encode("utf-8")) + len(r["stderr"].encode("utf-8"))
        if r["outputLimit"] and room < cap:
            reason = "output-limit"  # the aggregate budget (not the per-case cap) truncated this case
        emit({"type": "case", "jobId": job, "id": c["id"], **r})
        if reason == "output-limit":
            break
        if total >= agg_cap and c is not cases[-1]:
            reason = "output-limit"
            break
    emit({"type": "done", "jobId": job, "reason": reason})
    return 0


if __name__ == "__main__":
    sys.exit(main())
