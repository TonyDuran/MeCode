import unittest
from unittest.mock import patch
from runner import Runner


class JudgeTests(unittest.TestCase):
    def test_correct_real_process(self):
        result = Runner().run("correct", [1, 2, 3])
        self.assertEqual(result["verdict"], "ACCEPTED")
        self.assertEqual(result["stdout"], "6\n")
        self.assertEqual(result["returncode"], 0)
        self.assertTrue(result["cleanup_confirmed"])
        self.assertGreater(result["pid"], 0)

    def test_correct_all_six_fixed_cases(self):
        records = Runner().run_cases("correct")
        self.assertEqual([r["case"] for r in records],
                         ["empty", "singleton", "positive", "negative", "mixed", "duplicates"])
        self.assertTrue(all(r["verdict"] == "ACCEPTED" for r in records))
        self.assertTrue(all(r["cleanup_confirmed"] for r in records))

    def test_wrong_fixture_is_rejected(self):
        records = Runner().run_cases("wrong")
        self.assertTrue(all(r["verdict"] == "WRONG_ANSWER" for r in records))
        self.assertTrue(all(r["returncode"] == 0 for r in records))

    def test_exception_is_runtime_error(self):
        result = Runner().run("exception", [1])
        self.assertEqual(result["verdict"], "RUNTIME_ERROR")
        self.assertNotEqual(result["returncode"], 0)
        self.assertIn("benign fixture exception", result["stderr"])
        self.assertTrue(result["cleanup_confirmed"])

    def test_invalid_answer_documents_are_wrong_answer(self):
        for fixture in ("malformed", "extra", "boolean", "float", "empty_output", "invalid_utf8"):
            with self.subTest(fixture=fixture):
                result = Runner().run(fixture, [1])
                self.assertEqual(result["verdict"], "WRONG_ANSWER")
                self.assertEqual(result["returncode"], 0)
                self.assertTrue(result["cleanup_confirmed"])

    def test_timeout_then_clean_run(self):
        runner = Runner()
        result = runner.run("sleep_loop", [], budget=0.5)
        self.assertEqual(result["verdict"], "TIME_LIMIT")
        self.assertEqual(result["stop_reason"], "timeout")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertLess(result["elapsed_s"], 2.6)
        self.assertGreaterEqual(result["elapsed_s"], 0.45)
        self.assertEqual(runner.run("correct", [2])["verdict"], "ACCEPTED")

    def test_each_stream_is_bounded_and_oversize_rejected(self):
        for fixture, stream in (("oversize", "stdout"), ("oversize_stderr", "stderr")):
            with self.subTest(fixture=fixture):
                result = Runner().run(fixture, [1])
                self.assertEqual(result["verdict"], "WRONG_ANSWER")
                self.assertEqual(result["stop_reason"], "oversize")
                self.assertEqual(result["captured_bytes"][stream], 4096)
                self.assertGreater(result["observed_bytes"][stream], 4096)
                self.assertTrue(all(n <= 4096 for n in result["captured_bytes"].values()))
                self.assertTrue(result["cleanup_confirmed"])
        for fixture in ("exact_cap", "exact_cap_stderr"):
            with self.subTest(fixture=fixture):
                result = Runner().run(fixture, [1])
                self.assertEqual(result["verdict"], "ACCEPTED")
                self.assertIn(4096, result["captured_bytes"].values())

    def test_invalid_inputs_rejected_before_launch(self):
        invalid = ([True], [1.0], [101], [-101], list(range(17)), {}, "nums", None)
        with patch("runner.subprocess.Popen", side_effect=AssertionError("invalid input reached launch")) as launch:
            for nums in invalid:
                with self.subTest(nums=nums):
                    with self.assertRaises(ValueError):
                        Runner().run("correct", nums)
            launch.assert_not_called()
        self.assertEqual(Runner().run("correct", [-100, 100] * 8)["verdict"], "ACCEPTED")

    def test_invalid_budgets_rejected_before_launch(self):
        with patch("runner.subprocess.Popen", side_effect=AssertionError("invalid budget reached launch")) as launch:
            for budget in (0, -1, 3, float("nan"), float("inf"), True, "2"):
                with self.subTest(budget=budget):
                    with self.assertRaises(ValueError):
                        Runner().run("correct", [], budget=budget)
            launch.assert_not_called()

    def test_unit_injected_launch_failure_locks_runner(self):
        runner = Runner()
        with patch("runner.subprocess.Popen", side_effect=OSError("unit injected launch failure")) as launch:
            result = runner.run("correct", [])
            self.assertEqual(result["verdict"], "INTERNAL_RUNNER_FAILURE")
            self.assertFalse(runner.available)
            self.assertIsNone(result["pid"])
            again = runner.run_cases("correct")
            self.assertEqual(len(again), 1)
            self.assertEqual(again[0]["verdict"], "INTERNAL_RUNNER_FAILURE")
            self.assertEqual(launch.call_count, 1)

    def test_unit_injected_unconfirmed_cleanup_locks_runner(self):
        # Labeled fault injection: real cleanup still runs, then confirmation
        # is forced false. This never intentionally leaves a live child.
        runner = Runner()
        real_cleanup = runner._cleanup

        def unconfirmed(proc):
            self.assertTrue(real_cleanup(proc))
            return False

        with patch.object(runner, "_cleanup", side_effect=unconfirmed):
            result = runner.run("correct", [])
        self.assertEqual(result["verdict"], "INTERNAL_RUNNER_FAILURE")
        self.assertFalse(result["cleanup_confirmed"])
        self.assertFalse(runner.available)
        with patch("runner.subprocess.Popen") as launch:
            self.assertEqual(runner.run("correct", [1])["verdict"], "INTERNAL_RUNNER_FAILURE")
            launch.assert_not_called()
        import os
        with self.assertRaises(ChildProcessError):
            os.waitpid(result["pid"], os.WNOHANG)

    def test_unit_injected_capture_error_locks_runner(self):
        import selectors
        selector = selectors.DefaultSelector()
        runner = Runner()
        with patch("runner.selectors.DefaultSelector", return_value=selector):
            with patch.object(selector, "select", side_effect=OSError("unit injected capture failure")):
                result = runner.run("correct", [])
        self.assertEqual(result["verdict"], "INTERNAL_RUNNER_FAILURE")
        self.assertTrue(result["cleanup_confirmed"])
        self.assertFalse(runner.available)
        with patch("runner.subprocess.Popen") as launch:
            self.assertEqual(runner.run("correct", []) ["verdict"], "INTERNAL_RUNNER_FAILURE")
            launch.assert_not_called()

    def test_unknown_fixture_rejected_before_launch(self):
        with patch("runner.subprocess.Popen") as launch:
            for fixture in ("unknown", "../fixtures.py", "/bin/sh", "correct; true", [], None, True):
                with self.subTest(fixture=fixture):
                    with self.assertRaises(ValueError):
                        Runner().run(fixture, [])
            launch.assert_not_called()

    def test_unit_input_byte_cap_existing_guard(self):
        # Serialization fault injection; valid domain inputs are much smaller.
        with patch("runner.json.dumps", return_value=" " * 4097):
            with patch("runner.subprocess.Popen") as launch:
                with self.assertRaisesRegex(ValueError, "input exceeds cap"):
                    Runner().run("correct", [])
                launch.assert_not_called()

    def test_real_timeout_pid_is_reaped(self):
        import os
        result = Runner().run("sleep_loop", [], budget=0.5)
        self.assertEqual(result["verdict"], "TIME_LIMIT")
        with self.assertRaises(ChildProcessError):
            os.waitpid(result["pid"], os.WNOHANG)
        with self.assertRaises(ProcessLookupError):
            os.kill(result["pid"], 0)

    def test_unit_exit_wait_timeout_does_not_mask_overflow(self):
        import subprocess
        real_launch = subprocess.Popen

        def launch(*args, **kwargs):
            proc = real_launch(*args, **kwargs)
            real_wait = proc.wait
            # Force the exit-wait branch even if the tiny fixture has exited.
            proc.poll = lambda: None
            calls = 0

            def wait(timeout=None):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise subprocess.TimeoutExpired(proc.args, timeout)
                return real_wait(timeout=timeout)

            proc.wait = wait
            return proc

        with patch("runner.subprocess.Popen", side_effect=launch):
            result = Runner().run("oversize", [1])
        self.assertEqual(result["verdict"], "WRONG_ANSWER")
        self.assertEqual(result["stop_reason"], "oversize")
        self.assertTrue(result["cleanup_confirmed"])


if __name__ == "__main__":
    unittest.main()
