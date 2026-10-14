"""Code-only edited runner tests: no Docker and no submitted Python execution."""
import ast
import builtins
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
from unittest.mock import Mock, patch

import controller as c
import edited_runner as e
from test_controller import CID, FakeDocker, NoProcessTests, encoded


class StdinTransportTests(NoProcessTests):
    def test_bounded_stdin_reaches_capture_not_argv(self):
        source = b"def solve(nums):\n    return sum(nums)\n"
        with patch.dict(os.environ, {}, clear=True), patch.object(
                c.DockerCLI, "_capture", return_value=c.Reply(0)) as capture:
            c.DockerCLI().call(("start", "--attach", "--interactive", "a" * 64),
                               1.0, 42, input_bytes=source)
        self.assertEqual(capture.call_args.kwargs, {"input_bytes": source})
        self.assertNotIn(source.decode(), capture.call_args.args[0])
        self.assertEqual(capture.call_args.args[0][3:5], ["--host", c.ENDPOINT])

    def test_invalid_stdin_is_rejected_before_process(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(c.DockerCLI, "_capture") as capture:
            for payload in (b"x" * 16385, "text", bytearray(b"x")):
                with self.subTest(kind=type(payload)), self.assertRaisesRegex(c.Failure, "invalid_stdin"):
                    c.DockerCLI().call(("start",), 1, 42, input_bytes=payload)
            capture.assert_not_called()

    def capture(self, events, writes=(), reads=(), payload=b"abcdef", cap=8, clock=None):
        proc = Mock(returncode=0)
        proc.stdin = io.BytesIO()
        proc.stdin.fileno = lambda: 12
        proc.stdout = io.BytesIO()
        proc.stdout.fileno = lambda: 10
        proc.stderr = io.BytesIO()
        proc.stderr.fileno = lambda: 11
        proc.poll.return_value = None
        selector = Mock()
        selector.__enter__ = Mock(return_value=selector)
        selector.__exit__ = Mock(return_value=False)
        selector.get_map.side_effect = [True] * len(events) + [False]
        streams = {"stdin": proc.stdin, "stdout": proc.stdout, "stderr": proc.stderr}
        selector.select.side_effect = [
            [(Mock(fd=streams[name].fileno(), fileobj=streams[name], data=name), None)]
            if name else [] for name in events]
        with patch.object(c.subprocess, "Popen", return_value=proc) as popen, patch.object(
                c.selectors, "DefaultSelector", return_value=selector), patch.object(
                c.os, "set_blocking"), patch.object(c.os, "write", side_effect=writes) as write, patch.object(
                c.os, "read", side_effect=reads), patch.object(
                c.time, "monotonic", side_effect=clock or [0.0] * 100):
            result = c.DockerCLI._capture([c.DOCKER], 1, cap, input_bytes=payload)
        self.assertEqual(popen.call_args.kwargs["stdin"], subprocess.PIPE)
        self.assertTrue(all(stream.closed for stream in streams.values()))
        return result, proc, write, selector

    def test_partial_nonblocking_stdin_and_output_are_interleaved(self):
        result, _, write, selector = self.capture(
            ["stdin", "stdout", "stdin", "stdin", "stderr", "stdout", "stderr"],
            writes=[2, BlockingIOError(), 4], reads=[b"ok", b"err", b"", b""])
        self.assertIsNone(result.stopped)
        self.assertEqual((result.stdout, result.stderr), (b"ok", b"err"))
        self.assertEqual([call.args for call in write.call_args_list],
                         [(12, b"abcdef"), (12, b"cdef"), (12, b"cdef")])
        self.assertEqual(selector.unregister.call_count, 3)

    def test_blocked_stdin_still_hits_deadline(self):
        result, proc, _, _ = self.capture([None, None], clock=[0.0, 0.0, 2.0])
        self.assertEqual(result.stopped, "timeout")
        proc.kill.assert_called_once()
        proc.wait.assert_called_with(timeout=c.API_SECONDS)

    def test_output_overflow_while_stdin_pending(self):
        result, proc, write, _ = self.capture(["stdout"], reads=[b"123456789"])
        self.assertEqual(result.stopped, "output_limit")
        self.assertEqual(result.stdout, b"12345678")
        write.assert_not_called()
        proc.kill.assert_called_once()

    def test_closed_stdin_is_not_success(self):
        for failure in (BrokenPipeError(), 0):
            with self.subTest(failure=failure):
                result, proc, _, _ = self.capture(["stdin"], writes=[failure])
                self.assertEqual(result.stopped, "stdin_closed")
                proc.kill.assert_called_once()

    def test_empty_stdin_sends_eof_without_write(self):
        result, _, write, _ = self.capture([], payload=b"")
        self.assertIsNone(result.stopped)
        write.assert_not_called()

    def test_source_is_sent_in_bounded_chunks(self):
        result, _, write, _ = self.capture(["stdin"] * 4, writes=[4096] * 4,
                                          payload=b"x" * c.INPUT_CAP)
        self.assertIsNone(result.stopped)
        self.assertEqual([len(call.args[1]) for call in write.call_args_list], [4096] * 4)


class EditedRunnerTests(NoProcessTests):
    def test_correct_submission_stdin_and_verified_cleanup(self):
        import edited_runner as e
        from test_controller import CID, FakeDocker
        class FakeStdinDocker(FakeDocker):
            def call(self, args, timeout, cap, *, input_bytes=None):
                if args[0] == "start":
                    self.payload = input_bytes
                return super().call(args, timeout, cap)
        fake = FakeStdinDocker()
        fake.overrides["start"] = c.Reply(0, b'{"answers":[0,7,10,-6,5,10]}\n')
        source = "def solve(nums):\n    return sum(nums)\n"
        with tempfile.TemporaryDirectory(prefix="mecode-edited-test-") as temp, patch.dict(
                os.environ, {}, clear=True), patch.object(c, "LEGACY_STATE_DIR", Path(temp) / "legacy"):
            runner = e.Runner(fake, state_dir=Path(temp) / "state")
            result = runner.submit(source, "sum-array-v1")
            self.assertEqual(result["status"], "JUDGED")
            self.assertEqual(result["verdict"], "ACCEPTED")
            self.assertTrue(result["cleanup_confirmed"])
            self.assertFalse((Path(temp) / "state" / "pending.json").exists())
        self.assertEqual(fake.payload, source.encode())
        commands = [args for args, _, _ in fake.calls]
        self.assertIn(("start", "--attach", "--interactive", CID), commands)
        create = next(args for args in commands if args[0] == "create")
        baseline = c.create_args(create[create.index("--name") + 1])
        self.assertEqual(create, (*baseline[:-len(c.COMMAND)-1], "--interactive", c.IMAGE,
                                  "-I", "-B", "-c", e.WRAPPER))
        self.assertNotIn(source, str(commands))

    def test_duplicate_protocol_keys_are_ambiguous_not_accepted(self):
        import edited_runner as e
        submission = e._Submission(Mock(), b"", c.STATE_DIR, c.time.monotonic)
        with self.assertRaisesRegex(c.Failure, "invalid_judge_protocol"):
            submission._judge(b'{"answers":[],"answers":[0,7,10,-6,5,10]}')


class FakeStdinDocker(FakeDocker):
    def __init__(self):
        super().__init__()
        self.inputs = []
        self.overrides["start"] = c.Reply(0, b'{"answers":[0,7,10,-6,5,10]}\n')

    def call(self, args, timeout, cap, *, input_bytes=None):
        self.inputs.append((args[0], input_bytes))
        return super().call(args, timeout, cap)


class SubmissionFailureTests(NoProcessTests):
    def setUp(self):
        super().setUp()
        self.temp = tempfile.TemporaryDirectory(prefix="mecode-edited-cases-")
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / "state"
        self.fake = FakeStdinDocker()
        self.runner = e.Runner(self.fake, self.state)
        self.source = "def solve(nums):\n    return sum(nums)\n"
        env = patch.dict(os.environ, {}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        legacy = patch.object(c, "LEGACY_STATE_DIR", Path(self.temp.name) / "legacy")
        legacy.start()
        self.addCleanup(legacy.stop)

    def submit(self):
        return self.runner.submit(self.source, e.PROBLEM_ID)

    def assert_latched(self, result, reason):
        self.assertEqual(result["status"], "UNAVAILABLE")
        self.assertIsNone(result["verdict"])
        self.assertEqual(result["reason"], reason)
        self.assertTrue((self.state / "pending.json").exists())
        count = len(self.fake.calls)
        self.assertEqual(self.submit()["reason"], "operator_reconciliation_required")
        self.assertEqual(len(self.fake.calls), count)

    def test_correct_wrong_exception_then_correct_clear_latch(self):
        for output, verdict in (({"answers": [0, 7, 10, -6, 5, 10]}, "ACCEPTED"),
                                ({"answers": [1, 8, 11, -5, 6, 11]}, "WRONG_ANSWER"),
                                ({"error": "exception"}, "RUNTIME_ERROR"),
                                ({"answers": [None] * 6}, "WRONG_ANSWER"),
                                ({"answers": [0, 7, 10, -6, 5, 10]}, "ACCEPTED")):
            with self.subTest(verdict=verdict):
                self.fake.overrides["start"] = encoded(output)
                result = self.submit()
                self.assertEqual(result["status"], "JUDGED")
                self.assertEqual(result["verdict"], verdict)
                self.assertTrue(result["cleanup_confirmed"])
                self.assertFalse((self.state / "pending.json").exists())
        self.assertTrue(all(payload == (self.source.encode() if verb == "start" else None)
                            for verb, payload in self.fake.inputs))

    def test_invalid_inputs_never_call_transport_or_create_state(self):
        for source, problem in ((self.source, "other"), (self.source, None),
                                (None, e.PROBLEM_ID), (b"bytes", e.PROBLEM_ID),
                                ("x" * (e.SOURCE_CAP + 1), e.PROBLEM_ID),
                                ("é" * e.SOURCE_CAP, e.PROBLEM_ID), ("\ud800", e.PROBLEM_ID)):
            with self.subTest(problem=problem, kind=type(source)):
                result = self.runner.submit(source, problem)
                self.assertEqual(result["status"], "INVALID_INPUT")
                self.assertIsNone(result["verdict"])
        self.assertEqual(self.fake.calls, [])
        self.assertFalse(self.state.exists())

    def test_source_exact_byte_cap_is_allowed(self):
        self.source = "#" + "é" * 8191 + "\n"
        self.assertEqual(len(self.source.encode()), e.SOURCE_CAP)
        self.assertEqual(self.submit()["verdict"], "ACCEPTED")

    def test_timeout_cleans_exact_id_but_stays_unavailable(self):
        self.fake.overrides["start"] = c.Reply(-9, stopped="timeout")
        result = self.submit()
        self.assert_latched(result, "timeout")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertEqual([args for args, _, _ in self.fake.calls][-3:],
                         [("stop", "--time", "1", CID), ("rm", "--force", CID),
                          ("ps", "--all", "--quiet", "--no-trunc", "--filter", "id=" + CID)])

    def test_output_cap_defends_against_broken_transport(self):
        self.fake.overrides["start"] = c.Reply(0, b"x" * (c.CAP + 1), b"y" * c.CAP)
        result = self.submit()
        self.assert_latched(result, "output_limit")
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["stdout"]) + len(result["stderr"]), c.CAP)
        self.assertTrue(result["cleanup_confirmed"])

    def test_stale_fixed_controller_latch_is_not_bypassed(self):
        state = c.State(self.state)
        with state.locked():
            state.record("existing-fixed-smoke", CID, "failed:start")
        self.assert_latched(self.submit(), "operator_reconciliation_required")
        self.assertEqual(self.fake.calls, [])

    def test_unknown_create_never_starts_or_deletes_by_name(self):
        self.fake.overrides["create"] = c.Reply(-9, stopped="timeout")
        result = self.submit()
        self.assert_latched(result, "timeout")
        self.assertFalse(result["cleanup_confirmed"])
        self.assertEqual([args[0] for args, _, _ in self.fake.calls], ["info", "image", "create"])

    def test_late_create_id_is_cleanup_only(self):
        self.fake.overrides["create"] = c.Reply(-9, CID.encode(), stopped="timeout")
        result = self.submit()
        self.assert_latched(result, "timeout")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertNotIn("start", [args[0] for args, _, _ in self.fake.calls])

    def test_cleanup_failure_suppresses_previously_computed_verdict(self):
        self.fake.overrides["ps"] = c.Reply(1, stderr=b"daemon unavailable")
        result = self.submit()
        self.assert_latched(result, "cleanup_unconfirmed")
        self.assertFalse(result["cleanup_confirmed"])

    def test_latch_clear_failure_suppresses_verdict(self):
        with patch.object(c.State, "clear", side_effect=OSError("fake disk failure")):
            result = self.submit()
        self.assert_latched(result, "OSError")

    def test_start_ambiguity_and_bad_exit_state_never_yield_verdict(self):
        for index, reply in enumerate((c.Reply(1), c.Reply(0, b"{}", b"warning"),
                                       c.Reply(-9, stopped="stdin_closed"),
                                       OSError("gone"), KeyboardInterrupt())):
            with self.subTest(index=index):
                fake = FakeStdinDocker()
                fake.overrides["start"] = reply
                result = e.Runner(fake, Path(self.temp.name) / str(index)).submit(self.source, e.PROBLEM_ID)
                self.assertEqual(result["status"], "UNAVAILABLE")
                self.assertIsNone(result["verdict"])
                self.assertTrue(result["cleanup_confirmed"])
        self.fake.container["State"]["Running"] = True
        self.assert_latched(self.submit(), "unexpected_exit_state")

    def test_invalid_protocol_latches(self):
        self.fake.overrides["start"] = c.Reply(0, b"not JSON")
        self.assert_latched(self.submit(), "invalid_judge_protocol")

    def test_protocol_rejects_bool_float_extra_fields_and_depth(self):
        submission = e._Submission(Mock(), b"", self.state, c.time.monotonic)
        for output in (b'{"answers":[false,7,10,-6,5,10]}',
                       b'{"answers":[0.0,7,10,-6,5,10]}', b'{"answers":[]}',
                       b'{"error":"exception","extra":1}', b'{}\n{}', b'\xff',
                       b'[' * 2000 + b']' * 2000):
            with self.subTest(output=output[:60]), self.assertRaisesRegex(c.Failure, "invalid_judge_protocol"):
                submission._judge(output)

    def test_deadline_during_stdin_cannot_be_success(self):
        now = [0.0]
        original = self.fake.call
        def call(args, timeout, cap, **kwargs):
            reply = original(args, timeout, cap, **kwargs)
            if args[0] == "start":
                now[0] += c.WALL_SECONDS
            return reply
        self.fake.call = call
        self.runner.clock = lambda: now[0]
        result = self.submit()
        self.assert_latched(result, "wall_timeout")
        self.assertTrue(result["cleanup_confirmed"])

    def test_public_callable_uses_runner_without_host_execution(self):
        with patch.object(e, "Runner", return_value=self.runner):
            self.assertEqual(e.submit(self.source, e.PROBLEM_ID)["verdict"], "ACCEPTED")


class FixedWrapperTests(NoProcessTests):
    def run_wrapper(self, solve, payload=b"never compiled or executed", compile_error=None):
        # Execute ONLY the fixed team wrapper. Its inner compile/exec are mocks;
        # not even the benign submitted Python strings execute on this host.
        source_compile = Mock(return_value=object(), side_effect=compile_error)
        def install_fake(code, namespace):
            self.assertIs(code, source_compile.return_value)
            self.assertEqual(namespace, {"__name__": "__submission__"})
            namespace["solve"] = solve
        source_exec = Mock(side_effect=install_fake)
        safe_builtins = dict(vars(builtins), compile=source_compile, exec=source_exec)
        stdin = Mock(buffer=io.BytesIO(payload))
        stdout = io.StringIO()
        with patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", stdout):
            exec(compile(e.WRAPPER, "<fixed-wrapper-test>", "exec"), {"__builtins__": safe_builtins})
        return stdout.getvalue().encode(), source_compile, source_exec

    def test_fixed_cases_match_inspected_repo_literals_without_importing_runner(self):
        tree = ast.parse((Path(c.__file__).parent.parent / "trusted-judge" / "runner.py").read_text())
        cases = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                     and any(isinstance(name, ast.Name) and name.id == "CASES" for name in node.targets))
        self.assertEqual(cases, tuple((name, list(nums)) for name, nums, _ in e.CASES))
        self.assertEqual([row[2] for row in e.CASES], [0, 7, 10, -6, 5, 10])

    def test_fixed_wrapper_correct_wrong_and_exception_with_mock_solve(self):
        for solve, expected in ((Mock(side_effect=sum), "ACCEPTED"),
                                (Mock(side_effect=lambda nums: sum(nums) + 1), "WRONG_ANSWER"),
                                (Mock(side_effect=RuntimeError("benign")), "RUNTIME_ERROR")):
            with self.subTest(expected=expected):
                output, compiler, executor = self.run_wrapper(solve)
                compiler.assert_called_once_with("never compiled or executed", "<submission>", "exec")
                executor.assert_called_once()
                judge = e._Submission(Mock(), b"", c.STATE_DIR, c.time.monotonic)
                self.assertEqual(judge._judge(output)["verdict"], expected)
                if expected != "RUNTIME_ERROR":
                    self.assertEqual([call.args[0] for call in solve.call_args_list],
                                     [list(nums) for _, nums, _ in e.CASES])

    def test_fixed_wrapper_normalizes_nonintegers_and_huge_values(self):
        for value in (False, 0.0, "0", None, {}, 10**100):
            with self.subTest(kind=type(value)):
                output, _, _ = self.run_wrapper(Mock(return_value=value))
                self.assertEqual(json.loads(output), {"answers": [None] * 6})

    def test_fixed_wrapper_compile_failure_and_systemexit_are_runtime_errors(self):
        output, _, executor = self.run_wrapper(Mock(), compile_error=SyntaxError("fake"))
        executor.assert_not_called()
        self.assertEqual(json.loads(output), {"error": "exception"})
        output, _, _ = self.run_wrapper(Mock(side_effect=SystemExit(0)))
        self.assertEqual(json.loads(output), {"error": "exception"})

    def test_fixed_wrapper_defends_stdin_bound(self):
        with self.assertRaises(SystemExit) as error:
            self.run_wrapper(Mock(), payload=b"x" * (e.SOURCE_CAP + 1))
        self.assertEqual(error.exception.code, 64)
