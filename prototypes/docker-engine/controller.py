"""Fixed version smoke only. Not a learner-code runner or a security sandbox.

Self-authored by Talos. Live use requires separate operator approval; unit tests
inject a fake transport and never contact Docker.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time
import uuid

DOCKER = "/usr/local/bin/docker"
# Linux-only local rootless endpoint; never derived from ambient configuration.
ENDPOINT = f"unix:///run/user/{os.getuid()}/docker.sock"
IMAGE = "docker.io/library/python@sha256:cfe2e24a75302a15934d37c2d86412893c0aa934dc3a97cbb439d04c01890ca9"
PLATFORM = "linux/amd64"
COMMAND = ("-I", "-B", "--version")
EXPECTED_OUTPUT = b"Python 3.14.8\n"
CAP = 65536  # Combined stdout + stderr, including Docker diagnostics.
WALL_SECONDS = 5.0
API_SECONDS = 2.0
STATE_DIR = Path.home() / ".local" / "state" / "mecode-engine1"
LEGACY_STATE_DIR = Path(__file__).resolve().parent / ".state"
ID_RE = re.compile(r"[0-9a-f]{64}")
LIMIT_WARNING_RE = re.compile(r"\b(?:memory|swap|pids?|cpu)\b", re.IGNORECASE)


class Failure(Exception):
    def __init__(self, reason, reply=None):
        super().__init__(reason)
        self.reply = reply


@dataclass(frozen=True)
class Reply:
    code: int
    stdout: bytes = b""
    stderr: bytes = b""
    stopped: str | None = None


def checked_endpoint(endpoint, environ):
    if endpoint != ENDPOINT:
        raise Failure("unexpected_endpoint")
    # Reject even a matching override: no ambient context, TLS, API or config.
    if any(key.startswith("DOCKER_") for key in environ):
        raise Failure("ambient_docker_override")


class DockerCLI:
    """Bounded CLI adapter. Killing the CLI does NOT prove container cleanup."""

    def __init__(self, endpoint=ENDPOINT):
        self.endpoint = endpoint

    def call(self, args, timeout, cap):
        checked_endpoint(self.endpoint, os.environ)
        if timeout <= 0 or cap <= 0:
            raise Failure("exhausted_budget")
        # No inherited credentials/config/context/proxies or Docker variables.
        # This is normal explicit --host use, not an alternate access path.
        with tempfile.TemporaryDirectory(prefix="mecode-docker-config-") as config:
            argv = [DOCKER, "--config", config, "--host", self.endpoint, *args]
            return self._capture(argv, timeout, cap)

    @staticmethod
    def _capture(argv, timeout, cap):
        deadline = time.monotonic() + timeout
        proc = subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C"},
            start_new_session=True,
        )
        buffers = {"stdout": bytearray(), "stderr": bytearray()}
        stopped = None
        used = 0
        try:
            with selectors.DefaultSelector() as sel:
                for name in buffers:
                    stream = getattr(proc, name)
                    os.set_blocking(stream.fileno(), False)
                    sel.register(stream, selectors.EVENT_READ, name)
                while sel.get_map():
                    left = deadline - time.monotonic()
                    if left <= 0:
                        stopped = "timeout"
                        break
                    for key, _ in sel.select(min(left, 0.05)):
                        chunk = os.read(key.fd, min(4096, cap - used + 1))
                        if not chunk:
                            sel.unregister(key.fileobj)
                            continue
                        keep = min(len(chunk), cap - used)
                        buffers[key.data].extend(chunk[:keep])
                        used += keep
                        if len(chunk) > keep:
                            stopped = "output_limit"
                            break
                    if stopped:
                        break
                if not stopped:
                    try:
                        proc.wait(timeout=max(0.001, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        stopped = "timeout"
        finally:
            try:
                if proc.poll() is None:
                    proc.kill()
                # Separate, bounded direct-client reap; not daemon cleanup.
                proc.wait(timeout=API_SECONDS)
            finally:
                proc.stdout.close()
                proc.stderr.close()
        return Reply(proc.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]), stopped)


def create_args(name):
    return (
        "create", "--pull=never", "--platform", PLATFORM,
        "--name", name, "--label", "mecode.task=ENGINE-1", "--label", "mecode.owner=talos",
        "--network", "none", "--user", "65534:65534", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges=true", "--read-only",
        "--ipc", "private", "--cgroupns", "private", "--init", "--restart", "no",
        "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "32", "--cpus", "0.5",
        "--ulimit", "core=0:0", "--ulimit", "nofile=64:64",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777", "--shm-size", "1m",
        "--workdir", "/tmp", "--log-driver", "none",
        "--entrypoint", "/usr/local/bin/python3", IMAGE, *COMMAND,
    )  # Private PID namespace is Docker's default; no --pid=private CLI mode.


class State:
    """Cross-process flock plus persistent failure/in-flight latch.

    Never unlink the lock inode. A crash leaves pending.json and prevents reuse.
    Operator reconciliation is required; no auto-reset or name-based deletion.
    """

    def __init__(self, directory):
        self.directory = Path(directory)
        self.pending = self.directory / "pending.json"

    @contextmanager
    def locked(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Failure("unsafe_state_directory")
        fd = os.open(self.directory / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_nlink != 1 or info.st_mode & 0o077):
                raise Failure("unsafe_lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure("trial_busy") from None
            if os.path.lexists(self.pending):
                raise Failure("operator_reconciliation_required")
            yield
        finally:
            os.close(fd)

    def record(self, name, container_id, stage):
        # Persist before create: even abrupt controller death locks the next run.
        with tempfile.NamedTemporaryFile(mode="w", dir=self.directory, delete=False) as stream:
            temp = Path(stream.name)
            try:
                json.dump({"name": name, "container_id": container_id, "stage": stage}, stream)
                stream.flush()
                os.fsync(stream.fileno())
                os.replace(temp, self.pending)
            finally:
                temp.unlink(missing_ok=True)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def clear(self):
        self.pending.unlink()


class Controller:
    def __init__(self, transport, state_dir=STATE_DIR, endpoint=ENDPOINT, clock=time.monotonic):
        self.transport = transport
        self.state = State(state_dir)
        self.endpoint = endpoint
        self.clock = clock
        self.available = True

    def _call(self, args, deadline, cap=CAP):
        left = deadline - self.clock()
        if left <= 0:
            raise Failure("wall_timeout")
        reply = self.transport.call(tuple(args), min(API_SECONDS, left), cap)
        if len(reply.stdout) + len(reply.stderr) > cap:
            # Defend the controller contract even against a broken adapter.
            bounded = Reply(reply.code, reply.stdout[:cap],
                            reply.stderr[:max(0, cap - len(reply.stdout))], "output_limit")
            raise Failure("output_limit", bounded)
        if reply.stopped:
            raise Failure(reply.stopped, reply)
        if self.clock() >= deadline:
            raise Failure("wall_timeout", reply)
        if reply.code != 0:
            raise Failure("docker_command_failed", reply)
        # Warnings are not silently treated as accepted controls.
        if reply.stderr:
            raise Failure("docker_diagnostic", reply)
        return reply.stdout

    def _json(self, args, deadline):
        try:
            return json.loads(self._call(args, deadline))
        except (ValueError, UnicodeError):
            raise Failure("invalid_daemon_json") from None

    def _ready(self, deadline, result):
        info = self._json(("info", "--format", "{{json .}}"), deadline)
        if not isinstance(info, dict):
            raise Failure("invalid_daemon_info")
        # Docker can report capability degradation only in JSON Warnings, not
        # stderr. Null means no warnings; a missing/malformed field is unknown.
        warnings = info.get("Warnings")
        if "Warnings" not in info or (warnings is not None and (
                not isinstance(warnings, list) or not all(isinstance(w, str) for w in warnings))):
            raise Failure("invalid_daemon_warnings")
        result["daemon_warnings"] = warnings or []
        # Conservatively reject any warning about a relied-upon resource.
        # Word boundaries deliberately exclude cpuset; IO controls are unused.
        if any(LIMIT_WARNING_RE.search(warning) for warning in result["daemon_warnings"]):
            raise Failure("daemon_limit_warning")
        security = info.get("SecurityOptions", [])
        if (not isinstance(security, list) or not all(isinstance(s, str) for s in security)
                or "name=rootless" not in security
                or "name=seccomp,profile=builtin" not in security
                or any({"name=seccomp", "profile=unconfined"}.issubset(s.lower().split(","))
                       for s in security)
                or info.get("OSType") != "linux" or info.get("CgroupVersion") != "2"
                or info.get("CgroupDriver") != "systemd"):
            raise Failure("daemon_readiness_failed")
        images = self._json(("image", "inspect", IMAGE), deadline)
        if not isinstance(images, list) or len(images) != 1 or not isinstance(images[0], dict):
            raise Failure("invalid_image_info")
        image = images[0]
        # RepoDigests may omit docker.io/library; compare explicit known spelling.
        refs = image.get("RepoDigests")
        if (not isinstance(refs, list) or not any(ref in refs for ref in
                (IMAGE, IMAGE.removeprefix("docker.io/library/")))
                or image.get("Os") != "linux" or image.get("Architecture") != "amd64"):
            raise Failure("image_pin_or_platform_mismatch")
        config = image.get("Config")
        if not isinstance(config, dict) or config.get("Volumes") or config.get("ExposedPorts"):
            raise Failure("image_implicit_mount_or_port")
        # No inherited image healthcheck may execute additional commands.
        healthcheck = config.get("Healthcheck")
        if healthcheck and healthcheck != {"Test": ["NONE"]}:
            raise Failure("image_healthcheck")

    def _recover_create_id(self, exc, name):
        """A late ID is a candidate, not deletion authority until inspected.

        One bounded inspection outside the expired work budget; never start or
        retry create. Failure retains the original timeout and unknown cleanup.
        """
        reply = exc.reply
        if (str(exc) not in ("timeout", "wall_timeout") or reply is None or reply.stderr
                or not re.fullmatch(rb"[0-9a-f]{64}\n?", reply.stdout)):
            return None
        candidate = reply.stdout.decode("ascii").removesuffix("\n")
        try:
            records = self._json(("container", "inspect", candidate), self.clock() + API_SECONDS)
            if not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict):
                return None
            record = records[0]
            config = record.get("Config")
            labels = config.get("Labels") if isinstance(config, dict) else None
            if (record.get("Id") == candidate and record.get("Name") == "/" + name
                    and isinstance(labels, dict) and labels.get("mecode.task") == "ENGINE-1"
                    and labels.get("mecode.owner") == "talos"):
                return candidate
        except (Exception, KeyboardInterrupt):
            pass  # No trustworthy identity: leave reconciliation to the operator.
        return None

    def _cleanup(self, container_id):
        if not ID_RE.fullmatch(container_id):
            return False
        # TERM (<=1s grace), then force-remove. Attempt removal even if stop fails.
        # Each API has its own <=2s budget; never treat transport loss as absence.
        for args in (("stop", "--time", "1", container_id), ("rm", "--force", container_id)):
            try:
                self._call(args, self.clock() + API_SECONDS)
            except (Exception, KeyboardInterrupt):
                pass  # Even failed removal may mean it is already absent.
        try:
            remaining = self._call(
                ("ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + container_id),
                self.clock() + API_SECONDS,
            )
            return remaining == b""
        except (Exception, KeyboardInterrupt):
            return False

    def run(self):
        started = self.clock()
        result = {"status": "UNAVAILABLE", "stage": "gate", "reason": None,
                  "container_id": None, "cleanup_confirmed": None, "stdout": "",
                  "stderr": "", "truncated": False, "daemon_warnings": None}
        if not self.available:
            result["reason"] = "controller_latched"
            return result
        self.available = False  # Only the fully verified success path restores it.
        try:
            checked_endpoint(self.endpoint, os.environ)
            # Do not silently bypass an older checkout's local recovery record.
            if os.path.lexists(LEGACY_STATE_DIR / "pending.json"):
                raise Failure("legacy_operator_reconciliation_required")
            with self.state.locked():
                name = "hermes-talos-mecode-engine1-" + uuid.uuid4().hex
                container_id = None
                stage = "readiness"
                try:
                    self.state.record(name, None, stage)
                    deadline = started + WALL_SECONDS
                    self._ready(deadline, result)
                    stage = "create"
                    self.state.record(name, None, stage)
                    try:
                        raw = self._call(create_args(name), deadline)
                    except Failure as exc:
                        container_id = self._recover_create_id(exc, name)
                        if container_id is not None:
                            result["container_id"] = container_id
                            self.state.record(name, container_id, stage)
                        raise  # Recovery is cleanup only, never a successful run.
                    # No short IDs, prefixes, names, whitespace or extra lines.
                    if not re.fullmatch(rb"[0-9a-f]{64}\n?", raw):
                        raise Failure("invalid_create_id_cleanup_unknown")
                    container_id = raw.decode("ascii").removesuffix("\n")
                    result["container_id"] = container_id
                    stage = "start"
                    self.state.record(name, container_id, stage)
                    output = self._call(("start", "--attach", container_id), deadline)
                    result["stdout"] = output.decode("utf-8", errors="replace")
                    stage = "exit_inspect"
                    self.state.record(name, container_id, stage)
                    records = self._json(("container", "inspect", container_id), deadline)
                    if (not isinstance(records, list) or len(records) != 1
                            or not isinstance(records[0], dict) or records[0].get("Id") != container_id):
                        raise Failure("invalid_container_info")
                    state = records[0].get("State", {})
                    if (not isinstance(state, dict) or state.get("Status") != "exited"
                            or state.get("Running") is not False or state.get("OOMKilled") is not False
                            or type(state.get("ExitCode")) is not int or state["ExitCode"] != 0
                            or state.get("Error") != ""):
                        raise Failure("unexpected_exit_state")
                    if output != EXPECTED_OUTPUT:
                        raise Failure("unexpected_fixed_output")
                    result.update(status="FIXED_SMOKE_OK", stdout=output.decode("ascii"))
                except KeyboardInterrupt:
                    result["reason"] = "cancelled"
                except Exception as exc:
                    result["reason"] = str(exc) if isinstance(exc, Failure) else type(exc).__name__
                    if isinstance(exc, Failure) and exc.reply is not None:
                        result.update(stdout=exc.reply.stdout.decode("utf-8", errors="replace"),
                                      stderr=exc.reply.stderr.decode("utf-8", errors="replace"),
                                      truncated=exc.reply.stopped == "output_limit")
                finally:
                    result["stage"] = stage
                    if container_id is not None:
                        result["cleanup_confirmed"] = self._cleanup(container_id)
                        if not result["cleanup_confirmed"]:
                            result.update(status="UNAVAILABLE", reason="cleanup_unconfirmed")
                    elif stage == "create":
                        result["cleanup_confirmed"] = False
                    if result["status"] == "FIXED_SMOKE_OK" and result["cleanup_confirmed"] is True:
                        self.state.clear()
                        self.available = True
                    else:
                        result["status"] = "UNAVAILABLE"
                        self.state.record(name, container_id, "failed:" + stage)
        except (Exception, KeyboardInterrupt) as exc:
            self.available = False
            result.update(status="UNAVAILABLE", reason=str(exc) if isinstance(exc, Failure) else type(exc).__name__)
        result["elapsed_s"] = self.clock() - started
        return result


def _cancel(signum, frame):
    raise KeyboardInterrupt


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Approved fixed version smoke only; no learner source accepted.", allow_abbrev=False)
    parser.add_argument("--fixed-smoke", action="store_true", help="requires separate operator execution approval")
    args = parser.parse_args(argv)  # Unknown flags/positionals rejected before transport construction.
    if not args.fixed_smoke:
        parser.error("--fixed-smoke is required; this is not an execution approval")
    previous = signal.signal(signal.SIGTERM, _cancel)
    try:
        result = Controller(DockerCLI()).run()
    finally:
        signal.signal(signal.SIGTERM, previous)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "FIXED_SMOKE_OK" else 1


if __name__ == "__main__":
    raise SystemExit(main())
