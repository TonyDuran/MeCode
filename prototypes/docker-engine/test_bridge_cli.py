"""Trusted CLI protocol tests. No Docker or submitted-source execution."""
import io
import json
import signal
from unittest.mock import patch

import bridge_cli as b
import edited_runner as e
from test_controller import NoProcessTests


class BridgeCLITests(NoProcessTests):
    def invoke(self, raw, reply=None, argv=()):
        output = io.StringIO()
        with patch.object(e, "submit", return_value=reply) as submit:
            code = b.main(argv, io.BytesIO(raw), output)
        text = output.getvalue()
        self.assertLessEqual(len(text.encode()), b.OUTPUT_CAP)
        self.assertEqual(len(text.splitlines()), 1)
        result = json.loads(text)
        self.assertEqual(set(result), {"status", "verdict", "reason", "elapsed_s"})
        return code, result, submit

    def test_valid_source_only_reaches_existing_submit_and_output_is_projected(self):
        source = "def solve(nums): return sum(nums)"
        reply = {"status": "JUDGED", "verdict": "ACCEPTED", "reason": None,
                 "elapsed_s": 0.25, "cleanup_confirmed": True,
                 "stdout": "private source", "stderr": "private paths", "container_id": "secret"}
        code, result, submit = self.invoke(json.dumps({"source": source, "problemId": "sum-array-v1"}).encode(), reply)
        submit.assert_called_once_with(source, "sum-array-v1")
        self.assertEqual(code, 0)
        self.assertEqual(result, {"status": "JUDGED", "verdict": "ACCEPTED", "reason": None, "elapsed_s": 0.25})

    def test_malformed_overcap_and_unknown_fields_never_submit(self):
        values = [b"", b"{", b"{} {}", b"\xff", b"[0]", b"null",
                  b"x" * (b.INPUT_CAP + 1),
                  b'{"source":"","source":"x","problemId":"sum-array-v1"}']
        for request in ({"source": "", "problemId": "wrong"},
                        {"source": 1, "problemId": "sum-array-v1"},
                        {"source": "\ud800", "problemId": "sum-array-v1"},
                        {"source": "é" * 8193, "problemId": "sum-array-v1"},
                        {"source": "", "problemId": "sum-array-v1", "path": "/tmp/evil"}):
            values.append(json.dumps(request).encode())
        for raw in values:
            with self.subTest(raw=raw[:50]):
                _, result, submit = self.invoke(raw)
                self.assertEqual(result["status"], "INVALID_INPUT")
                submit.assert_not_called()

    def test_exact_byte_cap_and_worst_case_json_escape_fit(self):
        for source in ("é" * 8192, "\0" * 16384, "😀" * 4096):
            raw = json.dumps({"source": source, "problemId": "sum-array-v1"}).encode()
            self.assertLessEqual(len(raw), b.INPUT_CAP)
            _, _, submit = self.invoke(raw, {"status": "UNAVAILABLE"})
            submit.assert_called_once_with(source, "sum-array-v1")

    def test_failure_or_unconfirmed_cleanup_never_exposes_verdict_or_diagnostics(self):
        for reply in ({"status": "UNAVAILABLE", "verdict": "ACCEPTED", "reason": "private"},
                      {"status": "JUDGED", "verdict": "ACCEPTED", "cleanup_confirmed": False},
                      {"status": "JUDGED", "verdict": "BOGUS", "cleanup_confirmed": True},
                      {"status": "JUDGED", "verdict": "ACCEPTED", "cleanup_confirmed": True, "elapsed_s": float("nan")},
                      None):
            _, result, _ = self.invoke(b'{"source":"","problemId":"sum-array-v1"}', reply)
            self.assertEqual(result, {"status": "UNAVAILABLE", "verdict": None,
                                      "reason": "engine_unavailable", "elapsed_s": None})

    def test_cli_arguments_are_not_an_extension_point(self):
        _, result, submit = self.invoke(b'{}', argv=("--source", "evil"))
        self.assertEqual(result["status"], "INVALID_INPUT")
        submit.assert_not_called()

    def test_bounded_read_timeout_and_signal_handlers_restored(self):
        class StalledInput:
            def read(self, size):
                self.size = size
                signal.raise_signal(signal.SIGALRM)
        source = StalledInput()
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGALRM)}
        output = io.StringIO()
        with patch.object(e, "submit") as submit:
            b.main((), source, output)
        submit.assert_not_called()
        self.assertEqual(source.size, b.INPUT_CAP + 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "input_timeout")
        self.assertEqual(before, {sig: signal.getsignal(sig) for sig in before})

    def test_submit_exception_is_sanitized_and_term_uses_existing_cleanup_signal(self):
        output = io.StringIO()
        def interrupted(*args):
            signal.raise_signal(signal.SIGTERM)
        with patch.object(e, "submit", side_effect=interrupted):
            b.main((), io.BytesIO(b'{"source":"","problemId":"sum-array-v1"}'), output)
        self.assertEqual(json.loads(output.getvalue())["reason"], "engine_unavailable")

    def test_internal_validation_like_errors_are_not_blame_on_submission(self):
        for error in (ValueError("private"), UnicodeError("private"), RecursionError("private")):
            output = io.StringIO()
            with patch.object(e, "submit", side_effect=error):
                b.main((), io.BytesIO(b'{"source":"","problemId":"sum-array-v1"}'), output)
            self.assertEqual(json.loads(output.getvalue())["status"], "UNAVAILABLE")
