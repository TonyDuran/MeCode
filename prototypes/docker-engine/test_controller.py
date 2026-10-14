"""Code-only contract tests. No Docker, socket, network, or child process runs."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import controller as c

CID = "a" * 64
OTHER = "b" * 64


def encoded(value):
    return c.Reply(0, json.dumps(value).encode())


class FakeDocker:
    def __init__(self):
        self.calls = []
        self.overrides = {}
        self.info = {"SecurityOptions": ["name=rootless", "name=seccomp,profile=builtin"],
                     "OSType": "linux", "CgroupVersion": "2", "CgroupDriver": "systemd", "Warnings": []}
        self.image = {"RepoDigests": [c.IMAGE], "Os": "linux", "Architecture": "amd64", "Config": {}}
        self.container = {"Id": CID, "Config": {"Labels": {"mecode.task": "ENGINE-1", "mecode.owner": "talos"}},
                          "State": {"Status": "exited", "Running": False,
                          "OOMKilled": False, "ExitCode": 0, "Error": ""}}

    def call(self, args, timeout, cap):
        self.calls.append((args, timeout, cap))
        key = args[0]
        if key == "create":
            self.container["Name"] = "/" + args[args.index("--name") + 1]
        if key in self.overrides:
            value = self.overrides[key]
            if isinstance(value, BaseException):
                raise value
            return value
        replies = {"info": encoded(self.info), "image": encoded([self.image]),
                   "create": c.Reply(0, CID.encode() + b"\n"),
                   "start": c.Reply(0, c.EXPECTED_OUTPUT), "container": encoded([self.container]),
                   "stop": c.Reply(0, CID.encode() + b"\n"),
                   "rm": c.Reply(0, CID.encode() + b"\n"), "ps": c.Reply(0)}
        return replies[key]


class NoProcessTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        # Shared by lifecycle AND transport tests; local mocks may replace it.
        self.popen = patch.object(c.subprocess, "Popen", side_effect=AssertionError("REAL PROCESS FORBIDDEN"))
        self.popen.start()
        self.addCleanup(self.popen.stop)


class ControllerTests(NoProcessTests):
    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory(prefix="mecode-controller-test-")
        self.addCleanup(self.temp.cleanup)
        self.state_dir = Path(self.temp.name) / "state"
        self.fake = FakeDocker()
        self.engine = c.Controller(self.fake, self.state_dir)
        self.env = patch.dict(os.environ, {"HOME": str(Path.home())}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.legacy = patch.object(c, "LEGACY_STATE_DIR", Path(self.temp.name) / "legacy")
        self.legacy.start()
        self.addCleanup(self.legacy.stop)

    def commands(self):
        return [args for args, _, _ in self.fake.calls]

    def assert_failed(self, result):
        self.assertEqual(result["status"], "UNAVAILABLE")
        self.assertFalse(self.engine.available)
        count = len(self.fake.calls)
        self.assertEqual(self.engine.run()["reason"], "controller_latched")
        self.assertEqual(len(self.fake.calls), count)

    def test_success_and_second_run(self):
        result = self.engine.run()
        self.assertEqual(result["status"], "FIXED_SMOKE_OK")
        self.assertEqual(result["stdout"], "Python 3.14.8\n")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertFalse(self.engine.state.pending.exists())
        self.assertTrue(self.engine.available)
        self.assertEqual(self.engine.run()["status"], "FIXED_SMOKE_OK")
        creates = [args for args in self.commands() if args[0] == "create"]
        self.assertNotEqual(creates[0][creates[0].index("--name") + 1], creates[1][creates[1].index("--name") + 1])
        self.assertTrue(all(0 < timeout <= c.API_SECONDS and cap == c.CAP for _, timeout, cap in self.fake.calls))

    def test_complete_fixed_envelope(self):
        self.engine.run()
        args = next(args for args in self.commands() if args[0] == "create")
        expected = {"--platform": "linux/amd64", "--network": "none", "--user": "65534:65534",
                    "--cap-drop": "ALL", "--security-opt": "no-new-privileges=true", "--ipc": "private",
                    "--cgroupns": "private", "--restart": "no", "--memory": "256m",
                    "--memory-swap": "256m", "--pids-limit": "32", "--cpus": "0.5",
                    "--shm-size": "1m", "--log-driver": "none", "--workdir": "/tmp",
                    "--entrypoint": "/usr/local/bin/python3",
                    "--tmpfs": "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777"}
        for flag, value in expected.items():
            self.assertEqual(args[args.index(flag) + 1], value)
        for flag in ("--read-only", "--init", "--pull=never", "core=0:0", "nofile=64:64",
                     "mecode.owner=talos", "mecode.task=ENGINE-1"):
            self.assertIn(flag, args)
        for forbidden in ("--publish", "-p", "-P", "--publish-all", "--mount", "--volume", "-v",
                          "--privileged", "--device", "--cap-add", "--pid", "--env", "-e",
                          "--interactive", "--tty", "--rm", "--group-add"):
            self.assertNotIn(forbidden, args)
        self.assertEqual(args[-4:], (c.IMAGE, "-I", "-B", "--version"))

    def test_cleanup_uses_only_full_recorded_id(self):
        self.engine.run()
        self.assertEqual(self.commands()[-3:], [("stop", "--time", "1", CID),
                                               ("rm", "--force", CID),
                                               ("ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + CID)])
        self.assertFalse(self.engine._cleanup("a" * 12))
        self.assertFalse(self.engine._cleanup("--all"))

    def test_wrong_endpoint_rejected_before_transport(self):
        self.engine.endpoint = "unix:///var/run/docker.sock"
        self.assert_failed(self.engine.run())
        self.assertEqual(self.fake.calls, [])

    def test_ambient_overrides_rejected_even_matching_host(self):
        for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION"):
            with self.subTest(key=key), patch.dict(os.environ, {key: c.ENDPOINT}):
                engine = c.Controller(self.fake, self.state_dir)
                self.assertEqual(engine.run()["reason"], "ambient_docker_override")
        self.assertEqual(self.fake.calls, [])

    def test_readiness_rejects_rootful_and_missing_seccomp(self):
        for index, change in enumerate((
                {"SecurityOptions": ["name=seccomp,profile=builtin"]},
                {"SecurityOptions": ["name=rootless"]},
                {"CgroupVersion": "1"}, {"CgroupDriver": "cgroupfs"})):
            with self.subTest(change=change):
                fake = FakeDocker()
                fake.info.update(change)
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertEqual(result["reason"], "daemon_readiness_failed")
                self.assertEqual([args[0] for args, _, _ in fake.calls], ["info"])

    def test_bad_digest_platform_and_implicit_mounts(self):
        cases = (("RepoDigests", []), ("RepoDigests", ["python:latest"]),
                 ("Architecture", "arm64"), ("Os", "windows"),
                 ("Config", {"Volumes": {"/data": {}}}), ("Config", {"ExposedPorts": {"80/tcp": {}}}),
                 ("Config", {"Healthcheck": {"Test": ["CMD", "evil"]}}))
        for index, (key, value) in enumerate(cases):
            with self.subTest(key=key, value=value):
                fake = FakeDocker()
                fake.image[key] = value
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                self.assertEqual(engine.run()["status"], "UNAVAILABLE")
                self.assertNotIn("create", [args[0] for args, _, _ in fake.calls])

    def test_relied_upon_resource_warnings_fail_before_create(self):
        warnings = ("No memory limit support", "No swap limit support", "No pids limit support",
                    "No cpu cfs quota support", "No cpu cfs period support", "CPU limit unsupported")
        for index, warning in enumerate(warnings):
            with self.subTest(warning=warning):
                fake = FakeDocker()
                fake.info["Warnings"] = ["No cpuset support", warning]
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["reason"], "daemon_limit_warning")
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertEqual(result["daemon_warnings"], fake.info["Warnings"])
                self.assertEqual([args[0] for args, _, _ in fake.calls], ["info"])
                self.assertTrue(engine.state.pending.exists())

    def test_cpuset_and_io_warnings_are_recorded_but_allowed(self):
        warnings = ["No cpuset support", "No io.weight support", "No io.max support",
                    "No blkio throttle.read_bps_device support"]
        self.fake.info["Warnings"] = warnings
        result = self.engine.run()
        self.assertEqual(result["status"], "FIXED_SMOKE_OK")
        self.assertEqual(result["daemon_warnings"], warnings)

    def test_null_daemon_warnings_mean_no_warnings(self):
        self.fake.info["Warnings"] = None
        result = self.engine.run()
        self.assertEqual(result["status"], "FIXED_SMOKE_OK")
        self.assertEqual(result["daemon_warnings"], [])

    def test_missing_or_malformed_daemon_warnings_fail_closed(self):
        for index, value in enumerate(("missing", "No memory limit support", {}, [None], [42])):
            with self.subTest(value=value):
                fake = FakeDocker()
                if value == "missing":
                    del fake.info["Warnings"]
                else:
                    fake.info["Warnings"] = value
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                self.assertEqual(engine.run()["reason"], "invalid_daemon_warnings")
                self.assertEqual([args[0] for args, _, _ in fake.calls], ["info"])

    def test_unconfined_seccomp_rejected_even_alongside_builtin(self):
        for index, option in enumerate(("name=seccomp,profile=unconfined",
                                        "profile=unconfined,name=seccomp,extra=value", None)):
            with self.subTest(option=option):
                fake = FakeDocker()
                fake.info["SecurityOptions"].append(option)
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                self.assertEqual(engine.run()["reason"], "daemon_readiness_failed")
                self.assertEqual([args[0] for args, _, _ in fake.calls], ["info"])

    def test_normalized_repo_digest_allowed(self):
        self.fake.image["RepoDigests"] = [c.IMAGE.removeprefix("docker.io/library/")]
        self.assertEqual(self.engine.run()["status"], "FIXED_SMOKE_OK")

    def test_missing_image_fails_without_pull(self):
        self.fake.overrides["image"] = c.Reply(1, stderr=b"No such image")
        self.assert_failed(self.engine.run())
        self.assertEqual([args[0] for args in self.commands()], ["info", "image"])

    def test_unknown_create_outcome_latches_without_name_cleanup(self):
        self.fake.overrides["create"] = c.Reply(-9, stopped="timeout")
        result = self.engine.run()
        self.assert_failed(result)
        self.assertFalse(result["cleanup_confirmed"])
        self.assertIsNone(result["container_id"])
        self.assertNotIn("rm", [args[0] for args in self.commands()])
        count = len(self.fake.calls)
        other = c.Controller(self.fake, self.state_dir)
        self.assertEqual(other.run()["reason"], "operator_reconciliation_required")
        self.assertEqual(len(self.fake.calls), count)
        self.assertEqual(json.loads(self.engine.state.pending.read_text())["stage"], "failed:create")

    def test_malformed_create_id_never_becomes_cleanup_target(self):
        for index, raw in enumerate((b"a" * 12, b"--all", CID.encode() + b"\n" + OTHER.encode(),
                                     b" " + CID.encode(), b"", CID.upper().encode())):
            with self.subTest(raw=raw):
                fake = FakeDocker()
                fake.overrides["create"] = c.Reply(0, raw)
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                self.assertEqual(engine.run()["status"], "UNAVAILABLE")
                self.assertEqual([args[0] for args, _, _ in fake.calls], ["info", "image", "create"])

    def test_timed_out_create_verified_id_is_reaped_but_failure_stays_latched(self):
        for index, raw in enumerate((CID.encode(), CID.encode() + b"\n")):
            with self.subTest(raw=raw):
                fake = FakeDocker()
                fake.overrides["create"] = c.Reply(-9, raw, stopped="timeout")
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                original = fake.call
                records_before_stop = []
                def call(args, timeout, cap):
                    if args[0] == "stop":
                        records_before_stop.append(json.loads(engine.state.pending.read_text()))
                    return original(args, timeout, cap)
                fake.call = call
                result = engine.run()
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertEqual(result["reason"], "timeout")
                self.assertEqual(result["container_id"], CID)
                self.assertTrue(result["cleanup_confirmed"])
                self.assertEqual([record["container_id"] for record in records_before_stop], [CID])
                self.assertEqual([args[0] for args, _, _ in fake.calls],
                                 ["info", "image", "create", "container", "stop", "rm", "ps"])
                self.assertEqual(fake.calls[3][0], ("container", "inspect", CID))
                self.assertEqual(fake.calls[-2][0], ("rm", "--force", CID))
                self.assertTrue(all(0 < timeout <= c.API_SECONDS and cap == c.CAP
                                    for _, timeout, cap in fake.calls))
                record = json.loads(engine.state.pending.read_text())
                self.assertEqual(record["container_id"], CID)
                self.assertEqual(record["stage"], "failed:create")
                count = len(fake.calls)
                self.assertEqual(engine.run()["reason"], "controller_latched")
                self.assertEqual(c.Controller(fake, engine.state.directory).run()["reason"],
                                 "operator_reconciliation_required")
                self.assertEqual(len(fake.calls), count)

    def test_timed_out_create_absence_after_rm_failure_does_not_clear_failure(self):
        self.fake.overrides.update(create=c.Reply(-9, CID.encode(), stopped="timeout"),
                                   rm=c.Reply(1, stderr=b"No such container"))
        result = self.engine.run()
        self.assert_failed(result)
        self.assertEqual(result["reason"], "timeout")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertTrue(self.engine.state.pending.exists())
        self.assertEqual([args[0] for args in self.commands()][-3:], ["stop", "rm", "ps"])

    def test_timed_out_noisy_or_unknown_create_never_inspects_or_reaps(self):
        replies = (c.Reply(-9, CID.encode(), b"warn", "timeout"),
                   c.Reply(-9, stopped="timeout"), c.Reply(-9, b"a" * 12, stopped="timeout"),
                   c.Reply(-9, CID.encode() + b"\nnoise", stopped="timeout"),
                   c.Reply(-9, CID.upper().encode(), stopped="timeout"),
                   c.Reply(-9, b" " + CID.encode(), stopped="timeout"),
                   c.Reply(-9, CID.encode() + b"\n\n", stopped="timeout"),
                   c.Reply(-9, CID.encode(), stopped="output_limit"), c.Reply(1, CID.encode()),
                   c.Reply(0, CID.encode(), b"warn"))
        for index, reply in enumerate(replies):
            with self.subTest(reply=reply):
                fake = FakeDocker()
                fake.overrides["create"] = reply
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertIsNone(result["container_id"])
                self.assertFalse(result["cleanup_confirmed"])
                self.assertTrue(engine.state.pending.exists())
                self.assertEqual([args[0] for args, _, _ in fake.calls], ["info", "image", "create"])

    def test_timed_out_create_requires_matching_inspected_identity(self):
        changes = ({"Id": OTHER}, {"Name": "/wrong"}, {"Config": None}, {"Config": {}},
                   {"Config": {"Labels": None}}, {"Config": {"Labels": {}}},
                   {"Config": {"Labels": {"mecode.task": "OTHER", "mecode.owner": "talos"}}},
                   {"Config": {"Labels": {"mecode.task": "ENGINE-1", "mecode.owner": "other"}}})
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                fake = FakeDocker()
                fake.overrides["create"] = c.Reply(-9, CID.encode(), stopped="timeout")
                original = fake.call
                def call(args, timeout, cap):
                    if args[0] == "container":
                        fake.container.update(change)
                    return original(args, timeout, cap)
                fake.call = call
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["reason"], "timeout")
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertIsNone(result["container_id"])
                self.assertFalse(result["cleanup_confirmed"])
                self.assertEqual([args[0] for args, _, _ in fake.calls],
                                 ["info", "image", "create", "container"])
                self.assertTrue(engine.state.pending.exists())

    def test_timed_out_create_failed_inspection_never_reaps(self):
        replies = (c.Reply(1), c.Reply(0, b"not JSON"), c.Reply(-9, stopped="timeout"),
                   c.Reply(0, b"[]", b"warn"), c.Reply(0, b"x" * (c.CAP + 1)),
                   encoded([]), encoded([None]), encoded({}), encoded([{}, {}]),
                   OSError("daemon unavailable"), KeyboardInterrupt())
        for index, reply in enumerate(replies):
            with self.subTest(reply_type=type(reply).__name__, index=index):
                fake = FakeDocker()
                fake.overrides.update(create=c.Reply(-9, CID.encode(), stopped="timeout"), container=reply)
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertEqual(result["reason"], "timeout")
                self.assertIsNone(result["container_id"])
                self.assertFalse(result["cleanup_confirmed"])
                self.assertTrue(engine.state.pending.exists())
                self.assertEqual([args[0] for args, _, _ in fake.calls],
                                 ["info", "image", "create", "container"])

    def test_late_recovery_inspection_is_not_identity_evidence(self):
        now = [0.0]
        original = self.fake.call
        def call(args, timeout, cap):
            reply = original(args, timeout, cap)
            if args[0] == "container":
                now[0] += c.API_SECONDS
            return reply
        self.fake.call = call
        self.fake.overrides["create"] = c.Reply(-9, CID.encode(), stopped="timeout")
        self.engine.clock = lambda: now[0]
        result = self.engine.run()
        self.assert_failed(result)
        self.assertFalse(result["cleanup_confirmed"])
        self.assertNotIn("rm", [args[0] for args in self.commands()])

    def test_start_failures_and_cancellation_always_cleanup(self):
        cases = (c.Reply(-9, stopped="timeout"), c.Reply(-9, b"x" * c.CAP, stopped="output_limit"),
                 c.Reply(1), c.Reply(0, b"wrong\n"), c.Reply(0, c.EXPECTED_OUTPUT, b"warning"),
                 OSError("daemon gone"), KeyboardInterrupt())
        for index, reply in enumerate(cases):
            with self.subTest(reply=type(reply).__name__):
                fake = FakeDocker()
                fake.overrides["start"] = reply
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertTrue(result["cleanup_confirmed"])
                self.assertTrue(engine.state.pending.exists())
                self.assertEqual(fake.calls[-2][0], ("rm", "--force", CID))

    def test_overflow_retains_only_bounded_prefix(self):
        self.fake.overrides["start"] = c.Reply(-9, b"x" * c.CAP, stopped="output_limit")
        result = self.engine.run()
        self.assert_failed(result)
        self.assertTrue(result["truncated"])
        self.assertEqual(result["stdout"], "x" * c.CAP)
        self.assertTrue(result["cleanup_confirmed"])

    def test_broken_transport_cannot_return_unbounded_evidence(self):
        self.fake.overrides["start"] = c.Reply(0, b"x" * (c.CAP + 1), b"y" * c.CAP)
        result = self.engine.run()
        self.assert_failed(result)
        self.assertEqual(result["reason"], "output_limit")
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["stdout"]) + len(result["stderr"]), c.CAP)

    def test_pending_record_exists_before_create_and_has_id_before_start(self):
        original = self.fake.call
        def call(args, timeout, cap):
            if args[0] in ("create", "start", "container"):
                record = json.loads(self.engine.state.pending.read_text())
                self.assertEqual(record["stage"], "exit_inspect" if args[0] == "container" else args[0])
                self.assertEqual(record["container_id"], None if args[0] == "create" else CID)
                self.assertTrue(record["name"].startswith("hermes-talos-mecode-engine1-"))
            return original(args, timeout, cap)
        self.fake.call = call
        self.assertEqual(self.engine.run()["status"], "FIXED_SMOKE_OK")

    def test_cancellation_after_create_cleans_known_id(self):
        original = self.engine.state.record
        def record(name, container_id, stage):
            if container_id is not None and stage == "start":
                raise KeyboardInterrupt
            return original(name, container_id, stage)
        with patch.object(self.engine.state, "record", side_effect=record):
            result = self.engine.run()
        self.assertEqual(result["reason"], "cancelled")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertNotIn("start", [args[0] for args in self.commands()])

    def test_oom_running_nonzero_and_malformed_state(self):
        cases = ({"OOMKilled": True}, {"Running": True}, {"ExitCode": 137},
                 {"ExitCode": False}, {"Error": "failure"}, {"Status": "created"})
        for index, change in enumerate(cases):
            with self.subTest(change=change):
                fake = FakeDocker()
                fake.container["State"].update(change)
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["reason"], "unexpected_exit_state")
                self.assertTrue(result["cleanup_confirmed"])

    def test_inspect_wrong_id_and_bad_json_fail_closed(self):
        self.fake.container["Id"] = OTHER
        self.assert_failed(self.engine.run())
        self.assertEqual(self.commands()[-2], ("rm", "--force", CID))

    def test_invalid_json_fails_before_create(self):
        self.fake.overrides["info"] = c.Reply(0, b"not JSON")
        self.assert_failed(self.engine.run())
        self.assertEqual(len(self.commands()), 1)

    def test_cleanup_timeout_and_daemon_loss_are_not_absence(self):
        for index, (key, reply) in enumerate((("ps", c.Reply(-9, stopped="timeout")),
                                             ("ps", c.Reply(1, stderr=b"daemon unavailable")),
                                             ("ps", c.Reply(0, CID.encode() + b"\n")),
                                             ("ps", OSError("daemon unavailable")))):
            with self.subTest(key=key):
                fake = FakeDocker()
                fake.overrides[key] = reply
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["reason"], "cleanup_unconfirmed")
                self.assertFalse(result["cleanup_confirmed"])
                self.assertFalse(engine.available)
                self.assertTrue(engine.state.pending.exists())

    def test_stop_failure_still_force_removes_and_queries(self):
        self.fake.overrides["stop"] = c.Reply(1)
        self.assertTrue(self.engine.run()["cleanup_confirmed"])
        self.assertEqual([args[0] for args in self.commands()][-3:], ["stop", "rm", "ps"])

    def test_rm_failure_still_queries_and_clean_absence_confirms_cleanup(self):
        replies = (c.Reply(1, stderr=b"No such container"), c.Reply(-9, stopped="timeout"),
                   c.Reply(0, stderr=b"warn"), OSError("daemon unavailable"), KeyboardInterrupt())
        for index, reply in enumerate(replies):
            with self.subTest(reply_type=type(reply).__name__, index=index):
                fake = FakeDocker()
                fake.overrides["rm"] = reply
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertTrue(result["cleanup_confirmed"])
                self.assertEqual(result["status"], "FIXED_SMOKE_OK")
                self.assertFalse(engine.state.pending.exists())
                self.assertEqual(fake.calls[-1][0],
                                 ("ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + CID))
                self.assertTrue(0 < fake.calls[-1][1] <= c.API_SECONDS)

    def test_rm_failure_requires_clean_bounded_empty_absence_query(self):
        replies = (c.Reply(1, stderr=b"daemon unavailable"), c.Reply(0, stderr=b"warn"),
                   c.Reply(-9, stopped="timeout"), c.Reply(0, b"\n"), c.Reply(0, CID.encode()),
                   c.Reply(0, b"x" * (c.CAP + 1)), OSError("gone"), KeyboardInterrupt())
        for index, reply in enumerate(replies):
            with self.subTest(reply_type=type(reply).__name__, index=index):
                fake = FakeDocker()
                fake.overrides.update(rm=c.Reply(1, stderr=b"x"), ps=reply)
                engine = c.Controller(fake, Path(self.temp.name) / str(index))
                result = engine.run()
                self.assertEqual(result["reason"], "cleanup_unconfirmed")
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertFalse(result["cleanup_confirmed"])
                self.assertTrue(engine.state.pending.exists())
                self.assertEqual(fake.calls[-1][0][0], "ps")

    def test_rm_failure_and_late_absence_query_keep_latch(self):
        now = [0.0]
        original = self.fake.call
        def call(args, timeout, cap):
            reply = original(args, timeout, cap)
            if args[0] == "ps":
                now[0] += c.API_SECONDS
            return reply
        self.fake.call = call
        self.fake.overrides["rm"] = c.Reply(1)
        self.engine.clock = lambda: now[0]
        result = self.engine.run()
        self.assert_failed(result)
        self.assertFalse(result["cleanup_confirmed"])
        self.assertTrue(self.engine.state.pending.exists())

    def test_deadline_includes_readiness_and_create(self):
        now = [0.0]
        original = self.fake.call
        def call(args, timeout, cap):
            reply = original(args, timeout, cap)
            now[0] += 1.8
            return reply
        self.fake.call = call
        self.engine.clock = lambda: now[0]
        result = self.engine.run()
        self.assert_failed(result)
        self.assertEqual(result["stage"], "create")
        self.assertEqual(result["reason"], "wall_timeout")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertNotIn("start", [args[0] for args in self.commands()])

    def test_cross_instance_lock_refuses_concurrent_run(self):
        with self.engine.state.locked():
            other = c.Controller(self.fake, self.state_dir)
            self.assertEqual(other.run()["reason"], "trial_busy")
        self.assertEqual(self.fake.calls, [])

    def test_symlink_state_rejected(self):
        self.state_dir.symlink_to(self.temp.name, target_is_directory=True)
        self.assertEqual(self.engine.run()["reason"], "unsafe_state_directory")
        self.assertEqual(self.fake.calls, [])

    def test_default_state_is_durable_and_outside_worktree(self):
        repo = Path(c.__file__).resolve().parents[2]
        self.assertEqual(c.STATE_DIR, Path.home() / ".local" / "state" / "mecode-engine1")
        self.assertFalse(c.STATE_DIR.resolve().is_relative_to(repo))
        self.assertEqual(c.Controller(self.fake).state.directory, c.STATE_DIR)

    def test_state_permissions_remain_private_under_permissive_umask(self):
        previous = os.umask(0)
        try:
            with self.engine.state.locked():
                self.engine.state.record("test", CID, "start")
        finally:
            os.umask(previous)
        for path, mode in ((self.state_dir, 0o700), (self.state_dir / "lock", 0o600),
                           (self.engine.state.pending, 0o600)):
            info = path.lstat()
            self.assertEqual(stat.S_IMODE(info.st_mode), mode)
            self.assertEqual(info.st_uid, os.getuid())
        self.assertEqual(self.fake.calls, [])

    def test_unsafe_state_directory_mode_or_owner_rejected(self):
        self.state_dir.mkdir(mode=0o700)
        self.state_dir.chmod(0o755)
        self.assertEqual(self.engine.run()["reason"], "unsafe_state_directory")
        self.state_dir.chmod(0o700)
        engine = c.Controller(self.fake, self.state_dir)
        with patch.object(c.os, "getuid", return_value=os.getuid() + 1):
            self.assertEqual(engine.run()["reason"], "unsafe_state_directory")
        self.assertEqual(self.fake.calls, [])

    def test_unsafe_lock_mode_or_owner_rejected(self):
        self.state_dir.mkdir(mode=0o700)
        lock = self.state_dir / "lock"
        lock.touch(mode=0o600)
        lock.chmod(0o666)
        self.assertEqual(self.engine.run()["reason"], "unsafe_lock")
        lock.chmod(0o600)
        engine = c.Controller(self.fake, self.state_dir)
        actual = lock.stat()
        with patch.object(c.os, "fstat", return_value=Mock(
                st_mode=actual.st_mode, st_uid=os.getuid() + 1, st_nlink=1)):
            self.assertEqual(engine.run()["reason"], "unsafe_lock")
        self.assertEqual(self.fake.calls, [])

    def test_symlink_lock_rejected_without_transport(self):
        self.state_dir.mkdir(mode=0o700)
        target = Path(self.temp.name) / "target"
        target.write_text("preserve")
        (self.state_dir / "lock").symlink_to(target)
        self.assert_failed(self.engine.run())
        self.assertEqual(target.read_text(), "preserve")
        self.assertEqual(self.fake.calls, [])

    def test_legacy_latch_is_not_bypassed_by_new_default(self):
        c.LEGACY_STATE_DIR.mkdir(mode=0o700)
        pending = c.LEGACY_STATE_DIR / "pending.json"
        pending.write_text("preserve recovery evidence")
        result = self.engine.run()
        self.assert_failed(result)
        self.assertEqual(result["reason"], "legacy_operator_reconciliation_required")
        self.assertEqual(pending.read_text(), "preserve recovery evidence")
        self.assertFalse(self.state_dir.exists())
        self.assertEqual(self.fake.calls, [])

    def test_cli_rejects_source_arguments_before_transport(self):
        for args in ([], ["--source", "print(1)"], ["--fixed-smoke", "payload.py"],
                     ["--fixed-smoke", "--command", "id"], ["--fixed-smoke", "--", "-c", "print(1)"],
                     ["--fixed-smoke", "--endpoint", "tcp://localhost:2375"],
                     ["--fixed-smoke", "--env", "SECRET=value"], ["--fixed-smoke", "-"],
                     ["--fixed-smoke", "--file", "payload.py"], ["--fixed"]):
            with self.subTest(args=args), patch.object(c, "DockerCLI") as transport, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    c.main(args)
                self.assertEqual(error.exception.code, 2)
                transport.assert_not_called()

    def test_cli_restores_sigterm_handler_and_translates_cancellation(self):
        with self.assertRaises(KeyboardInterrupt):
            c._cancel(c.signal.SIGTERM, None)
        old_handler = object()
        with patch.object(c, "DockerCLI", return_value=self.fake), patch.object(c, "Controller", return_value=self.engine), patch.object(c.signal, "signal", return_value=old_handler) as handler, redirect_stdout(io.StringIO()):
            self.assertEqual(c.main(["--fixed-smoke"]), 0)
        self.assertEqual(handler.call_args_list[0].args, (c.signal.SIGTERM, c._cancel))
        self.assertEqual(handler.call_args_list[1].args, (c.signal.SIGTERM, old_handler))

    def test_cli_mocked_success_is_only_fixed_smoke_not_judge_verdict(self):
        with patch.object(c, "DockerCLI", return_value=self.fake), patch.object(c, "Controller", return_value=self.engine), redirect_stdout(io.StringIO()) as out:
            self.assertEqual(c.main(["--fixed-smoke"]), 0)
        self.assertEqual(json.loads(out.getvalue())["status"], "FIXED_SMOKE_OK")


class TransportTests(NoProcessTests):
    def test_endpoint_is_derived_from_trusted_uid_at_import(self):
        for uid in (42420, 42421):  # Synthetic identities, not host evidence.
            with self.subTest(uid=uid), patch.object(c.os, "getuid", return_value=uid):
                module = runpy.run_path(c.__file__, run_name="endpoint_test")
                expected = f"unix:///run/user/{uid}/docker.sock"
                self.assertEqual(module["ENDPOINT"], expected)
                self.assertEqual(module["DockerCLI"]().endpoint, expected)
                self.assertEqual(module["Controller"](FakeDocker()).endpoint, expected)

    def test_endpoint_derivation_ignores_environment(self):
        env = {"HOME": "/synthetic-home", "UID": "42421", "USER": "synthetic-user",
               "XDG_RUNTIME_DIR": "/synthetic-runtime", "DOCKER_HOST": "tcp://localhost:2375"}
        with patch.dict(os.environ, env, clear=True), patch.object(c.os, "getuid", return_value=42420):
            module = runpy.run_path(c.__file__, run_name="endpoint_test")
            self.assertEqual(module["ENDPOINT"], "unix:///run/user/42420/docker.sock")
            with self.assertRaisesRegex(module["Failure"], "ambient_docker_override"):
                module["DockerCLI"]().call(("info",), 1, 10)

    def test_remote_rootful_and_other_user_endpoints_are_rejected(self):
        endpoints = ("tcp://localhost:2375", "ssh://example.invalid",
                     "unix:///var/run/docker.sock", f"unix:///run/user/{os.getuid() + 1}/docker.sock")
        with patch.dict(os.environ, {}, clear=True), patch.object(c.DockerCLI, "_capture") as capture:
            for endpoint in endpoints:
                with self.subTest(endpoint=endpoint), self.assertRaisesRegex(c.Failure, "unexpected_endpoint"):
                    c.DockerCLI(endpoint).call(("info",), 1, 10)
            capture.assert_not_called()

    def test_actual_adapter_endpoint_is_checked_not_just_controller_setting(self):
        transport = c.DockerCLI()
        transport.endpoint = "unix:///var/run/docker.sock"
        with tempfile.TemporaryDirectory(prefix="mecode-endpoint-test-") as temp:
            with patch.dict(os.environ, {}, clear=True), patch.object(c.DockerCLI, "_capture") as capture, patch.object(c, "LEGACY_STATE_DIR", Path(temp) / "legacy"):
                engine = c.Controller(transport, Path(temp) / "state")
                self.assertEqual(engine.endpoint, c.ENDPOINT)
                self.assertEqual(engine.run()["reason"], "unexpected_endpoint")
                capture.assert_not_called()

    def test_unmocked_process_launch_is_forbidden(self):
        with self.assertRaisesRegex(AssertionError, "REAL PROCESS FORBIDDEN"):
            c.DockerCLI._capture([c.DOCKER], 1.0, 42)

    def test_explicit_endpoint_empty_config_and_bounded_call(self):
        with patch.dict(os.environ, {"HOME": "/should/not/be/read"}, clear=True), patch.object(c.DockerCLI, "_capture", return_value=c.Reply(0)) as capture:
            c.DockerCLI().call(("info",), 1.0, 42)
        argv, timeout, cap = capture.call_args.args
        self.assertEqual(argv[0], c.DOCKER)
        self.assertEqual(argv[3:], ["--host", c.ENDPOINT, "info"])
        self.assertEqual(argv[1], "--config")
        self.assertFalse(Path(argv[2]).exists())
        self.assertEqual((timeout, cap), (1.0, 42))

    def test_adapter_rechecks_endpoint_and_environment_each_call(self):
        with patch.object(c.DockerCLI, "_capture") as capture, patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(c.Failure):
                c.DockerCLI("tcp://localhost:2375").call(("info",), 1, 10)
            transport = c.DockerCLI()
            with patch.dict(os.environ, {"DOCKER_CONTEXT": "rootless"}):
                with self.assertRaises(c.Failure):
                    transport.call(("info",), 1, 10)
            capture.assert_not_called()

    def capture(self, chunks, cap=8, clock=None, wait=None):
        # Mock every process/pipe operation; test actual bounded capture logic.
        proc = Mock()
        if wait is not None:
            proc.wait.side_effect = wait
        proc.stdout.fileno.return_value = 10
        proc.stderr.fileno.return_value = 11
        proc.returncode = 0
        proc.poll.return_value = None
        selector = Mock()
        selector.__enter__ = Mock(return_value=selector)
        selector.__exit__ = Mock(return_value=False)
        selector.get_map.side_effect = [True] * len(chunks) + [False]
        selector.select.side_effect = [[(Mock(fd=10 if name == "stdout" else 11, data=name), None)] for name, _ in chunks]
        with patch.object(c.subprocess, "Popen", return_value=proc) as popen, patch.object(c.selectors, "DefaultSelector", return_value=selector), patch.object(c.os, "set_blocking"), patch.object(c.os, "read", side_effect=[data for _, data in chunks]), patch.object(c.time, "monotonic", side_effect=clock or [0.0] * 100):
            result = c.DockerCLI._capture([c.DOCKER, "--host", c.ENDPOINT, "info"], 1.0, cap)
        self.assertEqual(popen.call_args.kwargs["stdin"], subprocess.DEVNULL)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])
        self.assertEqual(popen.call_args.kwargs["env"], {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C"})
        proc.stdout.close.assert_called_once()
        proc.stderr.close.assert_called_once()
        return result, proc

    def test_capture_exact_cap_and_eof(self):
        result, _ = self.capture([("stdout", b"12345678"), ("stdout", b"")])
        self.assertEqual(result.stdout, b"12345678")
        self.assertIsNone(result.stopped)

    def test_capture_combined_stdout_stderr_overflow(self):
        result, proc = self.capture([("stdout", b"12345"), ("stderr", b"6789")])
        self.assertEqual((result.stdout, result.stderr), (b"12345", b"678"))
        self.assertEqual(result.stopped, "output_limit")
        proc.kill.assert_called_once()
        proc.wait.assert_called_with(timeout=c.API_SECONDS)

    def test_capture_closed_pipes_do_not_bypass_client_deadline(self):
        result, proc = self.capture([], wait=[subprocess.TimeoutExpired("fake", 1), 0])
        self.assertEqual(result.stopped, "timeout")
        proc.kill.assert_called_once()
        self.assertEqual(proc.wait.call_count, 2)

    def test_capture_silent_timeout_kills_and_reaps_client(self):
        result, proc = self.capture([("stdout", b"")], clock=[0.0, 2.0])
        self.assertEqual(result.stopped, "timeout")
        proc.kill.assert_called_once()
        proc.wait.assert_called_with(timeout=c.API_SECONDS)


if __name__ == "__main__":
    unittest.main()
