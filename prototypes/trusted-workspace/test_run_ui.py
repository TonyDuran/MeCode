"""Experimental Run renderer integration. Mock bridge only; never execute source."""
import json
import time
import unittest

import chrome_pipe
from runtime import STATE, URL
from test_engine_unavailable import RECORD, PUT_RECORD

Q = "document.getElementById"


class RunUI(unittest.TestCase):
    def setUp(self):
        base = STATE / self._testMethodName
        base.mkdir(exist_ok=False)
        chrome_pipe.BASE = base
        chrome_pipe.OUT = STATE / 'run-ui-report'
        self.b = chrome_pipe.ChromePipe(self._testMethodName)
        self.addCleanup(self.close)

    def close(self):
        self.assertTrue(self.b.close()['clean_browser_close'])

    def bridge(self, capabilities="Promise.resolve({enabled:true,reason:'ok'})"):
        self.b.cdp('Page.addScriptToEvaluateOnNewDocument', source="""
window.calls=[];
window.mecodeJudge={capabilities:()=>CAPS,run:request=>{calls.push(request);return new Promise((resolve,reject)=>{window.finish=resolve;window.fail=reject})}};
""".replace('CAPS', capabilities))
        self.b.cdp('Page.navigate', url=URL)
        self.b.wait("document.readyState==='complete'")
        self.b.wait(f"!{Q}('save-status').textContent.startsWith('Opening')")

    def enabled(self):
        self.bridge()
        self.b.wait(f"!{Q}('run-draft').disabled")
        self.assertTrue(self.b.js(f"{Q}('submit-draft').disabled"))
        self.assertIn('Experimental', self.b.js(f"{Q}('execution-note').textContent"))
        self.assertIn('Submit is unavailable', self.b.js(f"{Q}('execution-note').textContent"))

    def edit(self, text):
        self.b.js(f"{Q}('draft').value={json.dumps(text)};{Q}('draft').dispatchEvent(new Event('input'))")

    def click(self):
        self.b.js(f"{Q}('run-draft').click()")

    def finish(self, status='JUDGED', verdict='ACCEPTED', reason=None, elapsed=.12):
        # Faithful to desktop/judge-bridge.cjs: JUDGED has null reason; failures carry a code and null verdict/elapsed.
        if status == 'JUDGED':
            reply = {'status': status, 'verdict': verdict, 'reason': None, 'elapsed_s': elapsed}
        else:
            reply = {'status': status, 'verdict': None, 'elapsed_s': None, 'reason':
                     reason or ('invalid_source_or_problem' if status == 'INVALID_INPUT' else 'engine_unavailable')}
        self.b.js('finish('+json.dumps(reply)+')')
        self.b.wait(f"{Q}('run-result').dataset.state!=='pending'")
        self.assertNotIn('PRIVATE', self.b.js(f"{Q}('run-result').textContent"))
        self.assertNotIn('engine_unavailable', self.b.js(f"{Q}('run-result').textContent"))

    def verdict(self, verdict):
        self.enabled()
        source = 'def solve(nums):\n    return sum(nums) # 日本語\n'
        self.edit(source)
        self.click()
        self.assertEqual(self.b.js('calls'), [{'source': source, 'problemId': 'sum-array-v1'}])
        self.assertIn('Running', self.b.js(f"{Q}('run-result').textContent"))
        self.finish(verdict=verdict)
        self.assertIn(verdict, self.b.js(f"{Q}('run-result').textContent"))
        self.assertIn('not a submission', self.b.js(f"{Q}('run-result').textContent"))
        self.assertFalse(self.b.js(f"{Q}('run-draft').disabled"))
        self.b.wait(f"{Q}('save-status').dataset.state==='saved'")
        self.assertEqual(set(self.b.js(RECORD)['current']), {'schemaVersion','problemId','draft','theme','revision','sha256'})
        self.b.cdp('Page.reload')
        self.b.wait(f"!{Q}('run-draft').disabled")
        self.b.wait(f"{Q}('save-status').dataset.state==='saved'")
        self.assertEqual(self.b.js(f"{Q}('draft').value"), source)
        self.assertEqual(self.b.js(f"{Q}('run-result').textContent"), '')

    def test_accepted(self):
        self.verdict('ACCEPTED')

    def test_wrong_answer(self):
        self.verdict('WRONG_ANSWER')

    def test_runtime_error(self):
        self.verdict('RUNTIME_ERROR')

    def test_unavailable(self):
        self.enabled()
        self.click()
        self.finish(status='UNAVAILABLE')
        self.assertIn('unavailable', self.b.js(f"{Q}('run-result').textContent"))
        self.assertTrue(self.b.js(f"{Q}('run-draft').disabled"))

    def test_invalid_input(self):
        self.enabled()
        self.click()
        self.finish(status='INVALID_INPUT')
        self.assertIn('invalid', self.b.js(f"{Q}('run-result').textContent"))
        self.assertFalse(self.b.js(f"{Q}('run-draft').disabled"))

    def test_rejection(self):
        self.enabled()
        self.click()
        self.b.js("fail(new Error('PRIVATE SOURCE / internal path'))")
        self.b.wait(f"{Q}('run-result').dataset.state==='error'")
        self.assertNotIn('PRIVATE', self.b.js('document.body.textContent'))
        self.assertTrue(self.b.js(f"{Q}('run-draft').disabled"))

    def test_duplicate_click(self):
        self.enabled()
        self.click()
        self.b.js(f"{Q}('run-draft').disabled=false;{Q}('run-draft').dispatchEvent(new MouseEvent('click'));{Q}('submit-draft').disabled=false;{Q}('submit-draft').click()")
        self.assertEqual(len(self.b.js('calls')), 1)
        self.finish()

    def test_stale_edit_even_if_restored(self):
        self.enabled()
        self.edit('first')
        self.click()
        self.edit('second')
        self.edit('first')
        self.finish()
        self.assertNotIn('ACCEPTED', self.b.js(f"{Q}('run-result').textContent"))
        self.assertIn('discarded', self.b.js(f"{Q}('run-result').textContent"))
        self.click()
        self.finish()
        self.edit('new draft')
        self.assertNotIn('ACCEPTED', self.b.js(f"{Q}('run-result').textContent"))

    def test_disabled_and_rejected_capabilities(self):
        for caps in ["Promise.resolve({enabled:false,reason:'PRIVATE'})", "Promise.reject(new Error('PRIVATE'))", "Promise.resolve({enabled:'true',reason:'PRIVATE'})"]:
            with self.subTest(caps=caps):
                self.bridge(caps)
                self.assertTrue(self.b.js(f"{Q}('run-draft').disabled && {Q}('submit-draft').disabled"))
                self.assertIn('Run and Submit are unavailable', self.b.js(f"{Q}('execution-note').textContent"))
                self.assertNotIn('PRIVATE', self.b.js('document.body.textContent'))

    def reject(self, reply):
        self.enabled()
        self.click()
        self.b.js('finish('+json.dumps(reply)+')')
        self.b.wait(f"{Q}('run-result').dataset.state!=='pending'")
        text = self.b.js(f"{Q}('run-result').textContent")
        self.assertEqual(self.b.js(f"{Q}('run-result').dataset.state"), 'error')
        for forbidden in ['ACCEPTED', 'WRONG_ANSWER', 'RUNTIME_ERROR', 'PRIVATE', 'engine_unavailable']:
            self.assertNotIn(forbidden, text)
        self.assertTrue(self.b.js(f"{Q}('run-draft').disabled"))

    def test_malformed_judged_null_elapsed(self):
        self.reject({'status': 'JUDGED', 'verdict': 'ACCEPTED', 'reason': None, 'elapsed_s': None})

    def test_malformed_judged_private_reason(self):
        self.reject({'status': 'JUDGED', 'verdict': 'ACCEPTED', 'reason': 'PRIVATE SOURCE', 'elapsed_s': .12})

    def test_malformed_judged_elapsed_out_of_bound(self):
        self.reject({'status': 'JUDGED', 'verdict': 'ACCEPTED', 'reason': None, 'elapsed_s': 29})

    def test_malformed_unavailable_private_reason(self):
        self.reject({'status': 'UNAVAILABLE', 'verdict': None, 'reason': 'PRIVATE SOURCE / internal path', 'elapsed_s': None})

    def test_stale_unavailable_has_no_retry_instruction(self):
        self.enabled()
        self.edit('first')
        self.click()
        self.edit('second')
        self.finish(status='UNAVAILABLE')
        text = self.b.js(f"{Q}('run-result').textContent")
        self.assertNotIn('Run again', text)
        self.assertIn('No verdict', text)
        self.assertIn('Run stays disabled', text)
        self.assertEqual(self.b.js(f"{Q}('run-result').dataset.state"), 'error')
        self.assertTrue(self.b.js(f"{Q}('run-draft').disabled"))
        self.assertEqual(len(self.b.js('calls')), 1)

    def test_default_no_bridge(self):
        self.b.wait("document.readyState==='complete'")
        self.assertTrue(self.b.js(f"{Q}('run-draft').disabled && {Q}('submit-draft').disabled"))
        self.assertIn('Run and Submit are unavailable', self.b.js(f"{Q}('execution-note').textContent"))

    def geometry(self):
        self.assertTrue(self.b.js("document.documentElement.scrollWidth<=innerWidth"))
        self.assertTrue(self.b.js(f"(()=>{{const e={Q}('run-result'),r=e.getBoundingClientRect(),p=e.closest('.editor').getBoundingClientRect();return r.height>0 && r.top>=p.top && r.bottom<=p.bottom}})()"))

    def test_narrow_pending_and_verdict(self):
        self.enabled()
        for width in [1024, 375]:
            self.b.cdp('Emulation.setDeviceMetricsOverride', width=width, height=768, deviceScaleFactor=1, mobile=False)
            self.click()
            self.geometry()
            self.finish(verdict='RUNTIME_ERROR')
            self.geometry()
            self.b.screenshot(f'run-{width}.png')

    def test_corrupt_persistence_enabled_run(self):
        self.enabled()
        for text in ['first draft', 'second draft']:
            self.edit(text)
            self.b.wait(f"{Q}('save-status').dataset.state==='saved'")
            time.sleep(.2)
        self.assertTrue(self.b.js(PUT_RECORD))
        self.b.cdp('Page.reload')
        self.b.wait(f"{Q}('save-status').dataset.state==='error' && !{Q}('run-draft').disabled")
        stored = self.b.js(RECORD)
        for width in [1024, 375]:
            self.b.cdp('Emulation.setDeviceMetricsOverride', width=width, height=768, deviceScaleFactor=1, mobile=False)
            self.click()
            self.geometry()
            self.finish()
            self.geometry()
            self.assertIn('automatic saving blocked', self.b.js(f"{Q}('save-status').textContent"))
            self.assertTrue(self.b.js(f"(()=>{{const p={Q}('save-status').closest('.editor').getBoundingClientRect();return ['save-status','storage-notice','execution-note'].every(id=>{{const r={Q}(id).getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom}})}})()"))
            self.assertEqual(self.b.js(RECORD), stored)
            self.b.screenshot(f'run-corrupt-{width}.png')

    def test_fresh_process_reopens_draft_not_result(self):
        self.enabled()
        self.edit('def solve(nums):\n    return sum(nums)\n')
        self.click()
        self.finish()
        self.b.wait(f"{Q}('save-status').dataset.state==='saved'")
        stored = self.b.js(RECORD)
        pid = self.b.proc.pid
        self.assertTrue(self.b.close()['clean_browser_close'])
        self.b = chrome_pipe.ChromePipe('run-fresh-reopen')
        self.b.wait(f"{Q}('save-status').dataset.state==='saved'")
        self.assertNotEqual(self.b.proc.pid, pid)
        self.assertEqual(self.b.js(RECORD), stored)
        self.assertEqual(self.b.js(f"{Q}('draft').value"), stored['current']['draft'])
        self.assertEqual(self.b.js(f"{Q}('run-result').textContent"), '')
        self.assertTrue(self.b.js(f"{Q}('run-draft').disabled && {Q}('submit-draft').disabled"))


if __name__ == '__main__':
    unittest.main(verbosity=2)
