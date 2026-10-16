"""Trusted-authoring adversarial test (dev only, not shipped): big_road must terminate for a constant legal RNG."""
import os, sys, time

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
sys.path.insert(0, os.path.join(here, "problems"))
import p04_batch4 as p  # noqa: E402


class ConstRng:
    """Every randint(a, b) returns 2 (legal for every range big_road requests): forces u == v on every draw."""

    calls = 0

    def randint(self, a, b):
        assert a <= 2 <= b
        ConstRng.calls += 1
        return 2


t = time.time()
try:
    p.big_road(ConstRng())
    raise SystemExit("FAIL: constant RNG produced a road")
except RuntimeError as e:
    assert "u != v" in str(e), e
assert ConstRng.calls <= 501, ConstRng.calls
assert time.time() - t < 1
print(f"OK: constant-RNG big_road rejected with named error after {ConstRng.calls} randint calls")
