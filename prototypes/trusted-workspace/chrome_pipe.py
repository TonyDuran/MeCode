"""QA-only anonymous-pipe CDP, adapted from accepted Themis chrome_pipe.py.
No listening port, dependency, native renderer bridge or profile deletion.
"""
from pathlib import Path
import base64
import json
import os
import select
import subprocess
import time
from runtime import ROOT, URL, Guard, command, environment, STATE

OUT = STATE / 'evidence'
BASE = STATE / 'reopen'

class ChromePipe:
    def __init__(self, label):
        self.guard = Guard()
        self.session = None
        self.buffer = b''
        self.counter = 0
        self.events = []
        OUT.mkdir(parents=True, exist_ok=True)
        self.stderr = (OUT / f'{label}-stderr.txt').open('w')
        child_read, self.send_fd = os.pipe()
        self.recv_fd, child_write = os.pipe()
        def child_setup():
            os.dup2(child_read, 3)
            os.dup2(child_write, 4)
        self.command = command(BASE, headless=True)
        self.started = time.monotonic()
        self.proc = subprocess.Popen(self.command, env=environment(BASE), pass_fds=tuple(set([child_read, child_write, 3, 4])), preexec_fn=child_setup, stdout=subprocess.DEVNULL, stderr=self.stderr)
        os.close(child_read)
        os.close(child_write)
        self.guard.start(self.proc)
        self.version = {}
        self.startup_seconds = None
        try:
            self.connect()
        except Exception:
            self.close()
            raise

    def connect(self):
        self.version = self.cdp('Browser.getVersion')
        targets = self.cdp('Target.getTargets')['targetInfos']
        pages = [t for t in targets if t['type'] == 'page']
        if not pages:
            raise RuntimeError('No app page')
        self.session = self.cdp('Target.attachToTarget', targetId=pages[0]['targetId'], flatten=True)['sessionId']
        self.cdp('Page.enable')
        self.cdp('Runtime.enable')
        self.cdp('Log.enable')
        self.cdp('Network.enable')
        self.cdp('Network.emulateNetworkConditions', offline=True, latency=0, downloadThroughput=0, uploadThroughput=0)
        self.cdp('Emulation.setDeviceMetricsOverride', width=1440, height=900, deviceScaleFactor=1, mobile=False)
        self.cdp('Page.navigate', url=URL)
        self.wait("document.readyState === 'complete'")
        self.startup_seconds = time.monotonic() - self.started
        self.guard.check()

    def message(self, deadline):
        while b'\0' not in self.buffer:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([self.recv_fd], [], [], left)[0]:
                raise TimeoutError('CDP pipe')
            chunk = os.read(self.recv_fd, 65536)
            if not chunk:
                raise RuntimeError(f'Pipe closed: {self.proc.poll()}')
            self.buffer += chunk
        data, self.buffer = self.buffer.split(b'\0', 1)
        return json.loads(data)

    def cdp(self, method, **params):
        self.counter += 1
        req = {'id': self.counter, 'method': method, 'params': params}
        if self.session and not method.startswith(('Browser.', 'Target.')):
            req['sessionId'] = self.session
        os.write(self.send_fd, json.dumps(req).encode() + b'\0')
        deadline = time.monotonic() + 20
        while True:
            data = self.message(deadline)
            if data.get('id') == self.counter:
                if 'error' in data:
                    raise RuntimeError(data['error'])
                return data.get('result', {})
            if 'method' in data:
                self.events.append(data)

    def js(self, expression):
        data = self.cdp('Runtime.evaluate', expression=expression, returnByValue=True, awaitPromise=True)
        if 'exceptionDetails' in data:
            raise RuntimeError(data['exceptionDetails'])
        return data['result'].get('value')

    def wait(self, expression):
        end = time.monotonic() + 15
        while time.monotonic() < end:
            try:
                if self.js(expression):
                    return
            except RuntimeError as error:
                detail = error.args[0] if error.args else None
                if (not isinstance(detail, dict) or detail.get('code') != -32000 or
                    detail.get('message') != 'Inspected target navigated or closed' or self.proc.poll() is not None):
                    raise
                # Evaluation context can disappear DURING an intentional reload.
                # Retry only this observed navigation race within the same deadline.
                self.events.append({'method': 'QA.navigationEvaluationRace', 'params': detail})
            time.sleep(.04)
        raise TimeoutError(expression)

    def screenshot(self, name):
        data = self.cdp('Page.captureScreenshot', format='png', captureBeyondViewport=False)['data']
        (OUT / name).write_bytes(base64.b64decode(data))

    def close(self):
        clean = False
        if self.proc.poll() is None:
            try:
                self.cdp('Browser.close')
                self.proc.wait(timeout=15)
                clean = self.proc.returncode == 0
            except (RuntimeError, TimeoutError, BrokenPipeError, subprocess.TimeoutExpired):
                self.proc.terminate()
                self.proc.wait(timeout=10)
        for fd in [self.send_fd, self.recv_fd]:
            os.close(fd)
        self.stderr.close()
        metrics = {'pid': self.proc.pid, 'command': self.command, 'version': self.version, 'startup_seconds': self.startup_seconds, 'exit_code': self.proc.returncode, 'clean_browser_close': clean, 'peak_tree_rss_bytes': self.guard.peak_rss, 'peak_owned_disk_bytes': self.guard.peak_disk, 'transient_navigation_evaluations': [e['params'] for e in self.events if e['method'] == 'QA.navigationEvaluationRace']}
        self.guard.close()
        return metrics
