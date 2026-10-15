"""Guard must tolerate Chrome's task-owned transient files disappearing during sampling."""
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime import owned_bytes


class Vanished:
    def is_symlink(self):
        return False

    def lstat(self):
        raise FileNotFoundError('Chrome removed a scratch file')


class ResourceSampling(unittest.TestCase):
    def test_vanishing_owned_temp_does_not_kill_healthy_browser(self):
        with patch.object(Path, 'rglob', return_value=iter([Vanished()])):
            self.assertEqual(owned_bytes(), 0)


if __name__ == '__main__':
    unittest.main()
