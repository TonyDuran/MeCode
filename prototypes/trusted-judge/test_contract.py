"""Curated literal-oracle and cleanup checks; no historical bundles or writes."""
import json
import os
import subprocess
import unittest
from unittest.mock import Mock

from runner import CASES, Runner


class ContractTests(unittest.TestCase):
    def test_fixed_cases_against_literal_oracles_and_immediate_reaping(self):
        oracles = (
            ("empty", [], 0), ("singleton", [7], 7),
            ("positive", [1, 2, 3, 4], 10), ("negative", [-1, -2, -3], -6),
            ("mixed", [-100, 100, -3, 8], 5), ("duplicates", [5, 5, 5, -5], 10),
        )
        self.assertEqual(CASES, tuple((label, nums) for label, nums, _ in oracles))
        instance = Runner()
        for label, nums, answer in oracles:
            for fixture, verdict, emitted in (("correct", "ACCEPTED", answer),
                                              ("wrong", "WRONG_ANSWER", answer + 1)):
                with self.subTest(case=label, fixture=fixture):
                    result = instance.run(fixture, nums)
                    self.assertTrue(result["cleanup_confirmed"])
                    with self.assertRaises(ChildProcessError):
                        os.waitpid(result["pid"], os.WNOHANG)
                    with self.assertRaises(ProcessLookupError):
                        os.kill(result["pid"], 0)
                    self.assertEqual(result["verdict"], verdict)
                    self.assertEqual(result["returncode"], 0)
                    parsed = json.loads(result["stdout"])
                    self.assertIs(type(parsed), int)
                    self.assertEqual(parsed, emitted)

    def test_exact_cap_still_compares_answer_not_fixture_name(self):
        result = Runner().run("exact_cap", [2])
        self.assertEqual(result["verdict"], "WRONG_ANSWER")
        self.assertEqual(json.loads(result["stdout"]), 1)
        self.assertEqual(result["captured_bytes"]["stdout"], 4096)
        self.assertTrue(result["cleanup_confirmed"])

    def test_unit_cleanup_error_branches_without_live_process(self):
        # Fake-process branches are not evidence of actual OS cleanup failure.
        for failure in (OSError("injected kill error"),
                        subprocess.TimeoutExpired("fake process", 2)):
            fake = Mock()
            fake.poll.return_value = None
            if isinstance(failure, OSError):
                fake.kill.side_effect = failure
            else:
                fake.wait.side_effect = failure
            self.assertIs(Runner()._cleanup(fake), False)
        fake = Mock(returncode=0)
        fake.poll.return_value = 0
        self.assertIs(Runner()._cleanup(fake), True)
        fake.kill.assert_not_called()
        fake.wait.assert_called_once_with(timeout=2.0)


if __name__ == "__main__":
    unittest.main()
