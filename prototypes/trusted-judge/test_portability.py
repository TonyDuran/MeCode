"""Runtime-selection regression and real relocation smoke test (no evidence writes)."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from runner import FIXTURE_FILE, Runner


class PortabilityTests(unittest.TestCase):
    def test_launch_uses_current_interpreter(self):
        # Sentinel is never executed. Injection records the selected command.
        interpreter = "launching-python"
        with patch.object(sys, "executable", interpreter):
            with patch("runner.subprocess.Popen", side_effect=OSError("injected launch failure")) as launch:
                result = Runner().run("correct", [1])
        launch.assert_called_once_with(
            [interpreter, "-I", "-B", str(FIXTURE_FILE), "correct"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self.assertEqual(result["verdict"], "INTERNAL_RUNNER_FAILURE")

    def test_real_relocated_tree_from_unrelated_working_directory(self):
        root = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix="trusted-judge-", dir=os.environ.get("TMPDIR")) as directory:
            base = Path(directory)
            relocated = base / "prototype with spaces"
            relocated.mkdir()
            for name in ("runner.py", "fixtures.py", "test_runner.py"):
                shutil.copyfile(root / name, relocated / name)
            # Discover the existing real timeout/recovery test via an absolute
            # discovery path, with cwd outside the relocated tree. Fixtures resolve
            # relative to runner.py, never the caller's cwd or original checkout.
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-W", "error", "-m", "unittest",
                 "discover", "-s", str(relocated), "-p", "test_runner.py", "-v"],
                cwd=base, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("test_timeout_then_clean_run", result.stderr)
            self.assertIn("Ran 16 tests", result.stderr)
            self.assertEqual(sorted(p.name for p in relocated.iterdir()),
                             ["fixtures.py", "runner.py", "test_runner.py"])


if __name__ == "__main__":
    unittest.main()
