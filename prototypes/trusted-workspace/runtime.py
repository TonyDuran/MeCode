"""Fixed installed runtime, task-owned paths and resource guard. No network service."""
from pathlib import Path
import fcntl
import os
import shutil
import signal
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent
URL = (ROOT / 'index.html').as_uri()
STATE = Path(os.environ['MECODE_LOCAL_STATE']).resolve()
REPOSITORY = ROOT.parents[1]
if STATE == REPOSITORY or REPOSITORY in STATE.parents or STATE in REPOSITORY.parents:
    raise RuntimeError('State must be outside and must not contain the repository')
STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
CHROME = '/usr/bin/google-chrome'


def environment(base):
    env = os.environ.copy()
    for key, folder in [('HOME', 'home'), ('XDG_DATA_HOME', 'xdg-data'), ('XDG_CONFIG_HOME', 'xdg-config'), ('XDG_CACHE_HOME', 'xdg-cache'), ('XDG_RUNTIME_DIR', 'xdg-runtime'), ('TMPDIR', 'tmp')]:
        path = base / folder
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        env[key] = str(path)
    return env


def command(base, headless=False):
    args = [CHROME, f'--app={URL}', f'--user-data-dir={base / "profile"}', f'--disk-cache-dir={base / "cache"}', '--disk-cache-size=33554432', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--metrics-recording-only']
    if headless:
        args += ['--headless=new', '--remote-debugging-pipe']
    return args


def owned_bytes():
    return sum(p.lstat().st_blocks * 512 for p in STATE.rglob('*') if not p.is_symlink())


def tree_rss(pid):
    rows = {}
    for p in Path('/proc').iterdir():
        if not p.name.isdecimal():
            continue
        try:
            text = (p / 'stat').read_text().rsplit(')', 1)[1].split()
            rows[int(p.name)] = (int(text[1]), int(text[21]) * os.sysconf('SC_PAGE_SIZE'))
        except (OSError, ValueError, IndexError):
            pass
    descendants = {pid}
    while True:
        found = {n for n, (parent, _) in rows.items() if parent in descendants}
        if found <= descendants:
            break
        descendants |= found
    return sum(rows[n][1] for n in descendants if n in rows), sorted(descendants)


class Guard:
    def __init__(self):
        self.lock = (STATE / '.browser.lock').open('a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            self.lock.close()
            raise
        self.peak_rss = 0
        self.peak_disk = 0
        self.error = None
        self.stop = threading.Event()
        self.proc = None
        try:
            self.check()
        except Exception:
            self.lock.close()
            raise

    def check(self):
        disk = owned_bytes()
        self.peak_disk = max(self.peak_disk, disk)
        if disk > 1024**3:
            raise RuntimeError('Owned disk exceeds 1 GiB')
        for path in [STATE]:
            if shutil.disk_usage(path).free < 5 * 1024**3:
                raise RuntimeError('Filesystem free below 5 GiB')
        if self.proc:
            rss, _ = tree_rss(self.proc.pid)
            self.peak_rss = max(self.peak_rss, rss)
            if rss > 2 * 1024**3:
                raise RuntimeError('Browser tree RSS exceeds 2 GiB')

    def start(self, proc):
        self.proc = proc
        def watch():
            while not self.stop.wait(.5):
                try:
                    self.check()
                except Exception as exc:
                    self.error = str(exc)
                    if proc.poll() is None:
                        _, owned = tree_rss(proc.pid)
                        for pid in reversed(owned):
                            try:
                                os.kill(pid, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                    break
        self.thread = threading.Thread(target=watch, daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if hasattr(self, 'thread'):
            self.thread.join(timeout=3)
        self.lock.close()
        if self.error:
            raise RuntimeError(self.error)


# QA-only runtime support; no renderer bridge or bundled launcher.
