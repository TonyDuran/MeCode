"""Adversarial integration checks, separate from inherited happy-path suite.
Only CDP QA mutates data/DOM. No negative-test data is published as evidence.
"""
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
import posixpath
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import chrome_pipe
from runtime import ROOT, STATE
import generate


def _is_abs_clean(value):
    return (isinstance(value, str) and value.startswith('/') and '\0' not in value
            and posixpath.normpath(value) == value)


def receipt_source_path(raw):
    """Return the one exact fixture-source path a raw generation receipt recorded.

    Taken only from the receipt's own actual_argv[3] after validating the whole invocation
    record. The path is never resolved, read or executed, and a receipt-supplied pathname is
    not authenticity: the approved receipt's SHA-256 is still pinned by the acceptance command.
    """
    records, termination = raw.get('raw_records'), raw.get('termination')
    if not (isinstance(records, list) and isinstance(termination, list)
            and len(records) == len(termination) == len(generate.FIXTURES)):
        raise ValueError('receipt must hold exactly four ordered fixture entries')
    if raw.get('source_sha256') != generate.HASHES:
        raise ValueError('receipt source hashes differ from the pinned generator hashes')
    interpreter = source = None
    for fixture, record, entry in zip(generate.FIXTURES, records, termination):
        if not isinstance(entry, dict) or set(entry) != {'fixture', 'reaped', 'pid_absent', 'actual_argv'}:
            raise ValueError('malformed termination entry')
        if entry['fixture'] != fixture or not isinstance(record, dict) or record.get('fixture') != fixture:
            raise ValueError('fixture entries are not in the expected order')
        argv = entry['actual_argv']
        if not (isinstance(argv, list) and len(argv) == 5 and all(isinstance(a, str) for a in argv)):
            raise ValueError('malformed actual_argv')
        if argv[1:3] != ['-I', '-B'] or argv[4] != fixture:
            raise ValueError('unexpected interpreter flags or fixture argument')
        if not (_is_abs_clean(argv[0]) and _is_abs_clean(argv[3])):
            raise ValueError('interpreter and fixture source must be clean absolute paths')
        parts = posixpath.split(argv[3])
        if parts[1] != 'fixtures.py' or posixpath.basename(parts[0]) != 'trusted-judge':
            raise ValueError('fixture source must be trusted-judge/fixtures.py')
        if (interpreter, source) not in ((None, None), (argv[0], argv[3])):
            raise ValueError('mixed invocation paths')
        interpreter, source = argv[0], argv[3]
    return source


def receipt_matches_artifact(data, raw):
    """Compare every artifact record/termination entry with the raw receipt.

    Only the exact validated invocation path inside `File "<path>"` of raw stderr is replaced.
    Raises ValueError on any difference, including lengths (zip cannot hide an omission).
    """
    source = receipt_source_path(raw)
    if data.get('source_sha256') != generate.HASHES:
        raise ValueError('artifact source hashes differ from the pinned generator hashes')
    count = len(generate.FIXTURES)
    if not (isinstance(data.get('records'), list) and isinstance(data.get('termination'), list)
            and len(data['records']) == len(data['termination']) == count):
        raise ValueError('artifact must hold exactly four records and termination entries')
    for record, original, entry, projected in zip(data['records'], raw['raw_records'], raw['termination'], data['termination']):
        if not isinstance(original.get('stderr'), str):
            raise ValueError('malformed raw record')
        normalized = dict(original)
        if record.get('fixture') == 'exception' and f'File "{source}"' not in original['stderr']:
            raise ValueError('raw traceback does not cite the receipt invocation path')
        normalized['stderr'] = original['stderr'].replace(f'File "{source}"', 'File "fixtures.py"')
        if record != normalized:
            raise ValueError('artifact record differs from raw receipt after exact path normalization')
        if {k: v for k, v in entry.items() if k != 'actual_argv'} != projected:
            raise ValueError('artifact termination projection differs from raw receipt')
        if not (entry['reaped'] is True and entry['pid_absent'] is True and record['cleanup_confirmed'] is True):
            raise ValueError('cleanup was not confirmed')


class StaticBoundary(unittest.TestCase):
    def test_browser_has_no_execution_or_native_transport(self):
        for name in ['app.js', 'run-ui.js', 'persistence.js', 'evidence.js', 'workspace.html.in']:
            source = (ROOT/name).read_text()
            for forbidden in ['eval(', 'new Function', 'fetch(', 'XMLHttpRequest', 'WebSocket',
                              'Worker(', 'child_process', 'require(', 'import(', 'window.open(',
                              'ipcRenderer', 'sendBeacon', 'navigator.serviceWorker']:
                self.assertNotIn(forbidden, source, (name, forbidden))
        self.assertNotIn("$('draft')", (ROOT/'evidence.js').read_text())
        self.assertIn("connect-src 'none'", (ROOT/'index.html').read_text())
        self.assertNotIn('onsubmit=', (ROOT/'index.html').read_text())
        self.assertEqual((ROOT/'persistence.js').read_bytes().__class__, bytes)
        self.assertEqual(hashlib.sha256((ROOT/'persistence.js').read_bytes()).hexdigest(),
                         'ea8a6a96dc4b46c66011c414189647ddd5635a3dd50549b0bafe1c0f9fb9c300')

    def test_generator_identity_failure_before_any_launch(self):
        with patch.dict(generate.HASHES, {'runner.py': '0' * 64}):
            with patch.object(subprocess, 'Popen') as launch:
                with self.assertRaisesRegex(RuntimeError, 'identity differs'):
                    generate.generate()
                launch.assert_not_called()

    def test_artifact_matches_raw_receipt_and_literal_oracle(self):
        data = json.loads((ROOT/'fixture-evidence.json').read_text())
        raw = json.loads((STATE/'generation-receipt.json').read_text())
        self.assertEqual(data['generated_utc'], raw['generated_utc'])
        self.assertEqual(data['source_sha256'], raw['source_sha256'])
        self.assertEqual(data['nums'], [1,2,3,4])
        self.assertEqual(data['oracle'], 10)  # Literal independent oracle.
        self.assertEqual([r['verdict'] for r in raw['raw_records']],
                         ['ACCEPTED','WRONG_ANSWER','RUNTIME_ERROR','TIME_LIMIT'])
        for record, original, receipt in zip(data['records'], raw['raw_records'], raw['termination']):
            self.assertTrue(receipt['reaped'] and receipt['pid_absent'])
            self.assertEqual(receipt['actual_argv'][-1], record['fixture'])
            self.assertTrue(record['cleanup_confirmed'])
        # Full four-way comparison; the only normalization is the receipt's own validated
        # invocation path (it may come from a different checkout than this one).
        receipt_matches_artifact(data, raw)
        self.assertEqual(raw['raw_records'][0]['stdout'], '10\n')
        self.assertEqual(raw['raw_records'][1]['stdout'], '11\n')
        self.assertIn('RuntimeError: benign fixture exception', raw['raw_records'][2]['stderr'])
        self.assertEqual(raw['raw_records'][3]['stop_reason'], 'timeout')
        self.assertEqual(hashlib.sha256((ROOT/'fixture-evidence.json').read_bytes()).hexdigest(), raw['artifact_sha256'])
        for name in ['fixture-evidence.json', 'index.html']:
            self.assertLessEqual((ROOT/name).stat().st_size, 256*1024)
            self.assertNotIn('/home/', (ROOT/name).read_text())


class ReceiptPortability(unittest.TestCase):
    """Synthetic cross-checkout units for the receipt/artifact comparison only.

    Every receipt here is built in memory from the public artifact plus a clearly synthetic
    origin path. These are NOT authentic acceptance evidence; the authentic private receipt is
    exercised only by StaticBoundary against its SHA-pinned file.
    """
    ORIGIN = '/synthetic-origin-A/prototypes/trusted-judge/fixtures.py'
    PYTHON = '/synthetic/python/bin/python3'

    def make(self, origin=None):
        data = json.loads((ROOT/'fixture-evidence.json').read_text())
        origin = origin or self.ORIGIN
        raw_records = copy.deepcopy(data['records'])
        for record in raw_records:
            record['stderr'] = record['stderr'].replace('File "fixtures.py"', f'File "{origin}"')
        termination = [dict(t, actual_argv=[self.PYTHON, '-I', '-B', origin, t['fixture']]) for t in data['termination']]
        raw = {'generated_utc': data['generated_utc'], 'source_sha256': dict(generate.HASHES),
               'raw_records': raw_records, 'termination': termination}
        return data, raw

    def rejects(self, mutate, label):
        data, raw = self.make()
        mutate(data, raw)
        with self.assertRaises(ValueError, msg=label):
            receipt_matches_artifact(data, raw)

    def test_receipt_from_other_checkout_compares_after_exact_path_normalization(self):
        data, raw = self.make()
        self.assertNotEqual(self.ORIGIN, str(generate.JUDGE/'fixtures.py'))
        self.assertIn(self.ORIGIN, raw['raw_records'][2]['stderr'])
        self.assertEqual(receipt_source_path(raw), self.ORIGIN)
        receipt_matches_artifact(data, raw)

    def test_current_checkout_receipt_still_compares(self):
        data, raw = self.make(str(generate.JUDGE/'fixtures.py'))
        receipt_matches_artifact(data, raw)

    def test_unrelated_traceback_paths_are_rejected(self):
        for other in ['/elsewhere/prototypes/trusted-judge/fixtures.py', '/home/someone/fixtures.py', 'fixtures.py',
                      self.ORIGIN + 'c', self.ORIGIN.replace('synthetic-origin-A', 'synthetic-origin-B')]:
            def swap(data, raw, other=other):
                raw['raw_records'][2]['stderr'] = raw['raw_records'][2]['stderr'].replace(self.ORIGIN, other)
            self.rejects(swap, other)

        def extra_path(data, raw):
            raw['raw_records'][2]['stderr'] += '  File "/another/place.py", line 1, in <module>\n'
        self.rejects(extra_path, 'extra traceback path')

        def mixed_line(data, raw):
            raw['raw_records'][2]['stderr'] = raw['raw_records'][2]['stderr'].replace(
                'line 22', 'line 22 /home/hermes/data/other/trusted-judge/fixtures.py')
        self.rejects(mixed_line, 'unrelated path on same line')

    def test_malformed_mismatched_or_mixed_invocation_is_rejected(self):
        def argv(i, fn):
            def mutate(data, raw): raw['termination'][i]['actual_argv'] = fn(list(raw['termination'][i]['actual_argv']))
            return mutate
        cases = {
            'relative source': argv(0, lambda a: a[:3] + ['trusted-judge/fixtures.py'] + a[4:]),
            'relative interpreter': argv(0, lambda a: ['python3'] + a[1:]),
            'argv too short': argv(0, lambda a: a[:4]),
            'argv too long': argv(0, lambda a: a + ['extra']),
            'flags changed': argv(1, lambda a: [a[0], '-S', '-B'] + a[3:]),
            'flags swapped': argv(1, lambda a: [a[0], '-B', '-I'] + a[3:]),
            'wrong basename': argv(2, lambda a: a[:3] + [a[3].replace('fixtures.py', 'runner.py')] + a[4:]),
            'wrong parent': argv(2, lambda a: a[:3] + [a[3].replace('trusted-judge', 'elsewhere')] + a[4:]),
            'dotdot component': argv(2, lambda a: a[:3] + ['/synthetic-origin-A/x/../prototypes/trusted-judge/fixtures.py'] + a[4:]),
            'mixed source paths': argv(3, lambda a: a[:3] + [a[3].replace('origin-A', 'origin-B')] + a[4:]),
            'mixed interpreter': argv(3, lambda a: ['/other/python3'] + a[1:]),
            'fixture argument mismatch': argv(1, lambda a: a[:4] + ['correct']),
            'non-string element': argv(0, lambda a: a[:4] + [7]),
        }
        for label, mutate in cases.items():
            self.rejects(mutate, label)

    def test_wrong_missing_extra_or_reordered_records_are_rejected(self):
        def term(fn):
            def mutate(data, raw): fn(raw['termination'])
            return mutate
        def both(fn):
            def mutate(data, raw): fn(raw['raw_records']); fn(raw['termination']); fn(data['records']); fn(data['termination'])
            return mutate
        self.rejects(term(lambda t: t.pop()), 'missing termination entry')
        self.rejects(term(lambda t: t.append(copy.deepcopy(t[0]))), 'extra termination entry')
        self.rejects(term(lambda t: t.reverse()), 'reordered termination')
        self.rejects(term(lambda t: t[1].update(fixture='correct')), 'duplicate fixture')
        self.rejects(term(lambda t: t[0].update(extra=True)), 'extra termination key')
        self.rejects(term(lambda t: t[0].pop('reaped')), 'missing termination key')
        self.rejects(both(lambda items: items.pop()), 'every list one short (zip must not hide omission)')
        self.rejects(lambda d, r: r['raw_records'].pop(), 'raw record missing')
        self.rejects(lambda d, r: d['records'].pop(), 'artifact record missing')
        self.rejects(lambda d, r: r['raw_records'].reverse(), 'raw records reordered')
        self.rejects(lambda d, r: d['termination'].pop(), 'artifact termination missing')

    def test_source_hashes_are_checked_against_the_pinned_values(self):
        self.rejects(lambda d, r: r['source_sha256'].update({'fixtures.py': '0' * 64}), 'receipt hash changed')
        self.rejects(lambda d, r: r['source_sha256'].pop('runner.py'), 'receipt hash missing')
        self.rejects(lambda d, r: r['source_sha256'].update(extra='0' * 64), 'receipt hash extra')
        data, raw = self.make()
        pinned_elsewhere = dict(generate.HASHES, **{'runner.py': '0' * 64})
        data['source_sha256'] = dict(pinned_elsewhere); raw['source_sha256'] = dict(pinned_elsewhere)
        with self.assertRaises(ValueError):  # receipt and artifact agree with each other, not with the pin
            receipt_matches_artifact(data, raw)

    def test_record_content_still_has_to_match_exactly(self):
        self.rejects(lambda d, r: r['raw_records'][0].update(stdout='11\n'), 'stdout')
        self.rejects(lambda d, r: r['raw_records'][1].update(verdict='ACCEPTED'), 'verdict')
        self.rejects(lambda d, r: r['raw_records'][0].update(cleanup_confirmed=False), 'cleanup')
        self.rejects(lambda d, r: r['raw_records'][0]['captured_bytes'].update(stdout=99), 'raw counts')
        self.rejects(lambda d, r: r['raw_records'][0].update(elapsed_s=9.0), 'timing')
        self.rejects(lambda d, r: r['raw_records'][2].update(stderr=r['raw_records'][2]['stderr'] + 'x'), 'stderr suffix')
        self.rejects(lambda d, r: r['termination'][0].update(pid_absent=False), 'termination projection')
        self.rejects(lambda d, r: d['termination'][0].update(reaped=False), 'artifact termination projection')


class BrowserNegatives(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        chrome_pipe.BASE = STATE/'negative-profile'
        chrome_pipe.OUT = STATE/'negative-evidence'
        cls.browser = chrome_pipe.ChromePipe('negative')
        cls.browser.wait("document.getElementById('evidence-status').dataset.state==='ready'")
        cls.text = (ROOT/'fixture-evidence.json').read_text()
        cls.data = json.loads(cls.text)
        cls.targets = cls.browser.cdp('Target.getTargets')['targetInfos']
        cls.results = [{'case': 'baseline targets', 'targets': cls.targets}]

    @classmethod
    def tearDownClass(cls):
        metrics = cls.browser.close()
        (STATE/'negative-tests.json').write_text(json.dumps({'cases': cls.results, 'close': metrics}, indent=2)+'\n')
        if not metrics['clean_browser_close'] or metrics['exit_code'] != 0:
            raise AssertionError(metrics)

    def reject(self, label, text, reason):
        result = self.browser.js(f"(async()=>{{try{{await FixtureEvidence.validate({json.dumps(text)});return 'UNEXPECTED_ACCEPT'}}catch(e){{return e.message}}}})()")
        self.results.append({'case': label, 'observed': result, 'expected_reason': reason})
        self.assertIn(reason, result, label)
        self.assertNotEqual(result, 'UNEXPECTED_ACCEPT')

    def test_invalid_envelopes_and_identity(self):
        for label, value, reason in [('missing', None, 'missing'), ('empty', '', 'missing'),
                                     ('malformed', '{broken', 'malformed JSON'), ('null', 'null', 'malformed envelope'),
                                     ('array', '[]', 'malformed envelope'), ('overcap', 'x'*(256*1024+1), 'oversized'),
                                     ('unicode-overcap', '🦊'*(65537), 'oversized')]:
            self.reject(label, value, reason)
        mutations = [
            ('unknown schema', lambda d: d.update(schema_version=99), 'identity'),
            ('wrong problem', lambda d: d.update(problem_id='other'), 'identity'),
            ('wrong case', lambda d: d.update(case_id='empty'), 'identity'),
            ('wrong nums', lambda d: d.update(nums=[]), 'identity'),
            ('boolean oracle', lambda d: d.update(oracle=True), 'identity'),
            ('wrong revision', lambda d: d.update(judge_revision='0'*40), 'source identity'),
            ('wrong hash', lambda d: d['source_sha256'].update({'runner.py':'0'*64}), 'source identity'),
            ('extra fields', lambda d: d.update(draft='pretend judged'), 'malformed envelope'),
            ('missing fixture', lambda d: d['records'].pop(), 'missing fixture'),
            ('different fixture', lambda d: d['records'][0].update(fixture='malformed'), 'fixture identity'),
            ('swapped fixtures', lambda d: d['records'].reverse(), 'fixture identity'),
            ('relabeled wrong', lambda d: d['records'][1].update(verdict='ACCEPTED'), 'fixture identity'),
            ('unconfirmed cleanup', lambda d: d['records'][0].update(cleanup_confirmed=False), 'receipt'),
            ('missing record field', lambda d: d['records'][0].pop('stdout'), 'malformed record'),
            ('bad elapsed', lambda d: d['records'][0].update(elapsed_s='1'), 'receipt'),
            ('wrong exit', lambda d: d['records'][0].update(returncode=1), 'exit/status'),
            ('false termination', lambda d: d['termination'][0].update(pid_absent=False), 'termination'),
            ('bad stream count', lambda d: d['records'][0]['captured_bytes'].update(stdout=999), 'stream counts'),
            ('stale', lambda d: d.update(generated_utc='2000-01-01T00:00:00Z'), 'stale'),
            ('future', lambda d: d.update(generated_utc='2099-01-01T00:00:00Z'), 'future'),
            ('invalid date', lambda d: d.update(generated_utc='2026-02-30T00:00:00Z'), 'stale'),
            ('changed invocation', lambda d: d.update(invocation='run editor'), 'invocation'),
        ]
        for label, mutate, reason in mutations:
            d = copy.deepcopy(self.data); mutate(d)
            self.reject(label, json.dumps(d), reason)
        self.reject('valid structure but altered artifact bytes', self.text+' ', 'digest mismatch')
        bad = copy.deepcopy(self.data)
        bad['records'][2]['stderr'] = '<img src=x onerror="window.__executed=true">'
        self.reject('HTML stream cannot replace pinned artifact', json.dumps(bad), 'digest mismatch')
        # Genuine artifact also expires without changing its bytes or hash.
        result = self.browser.js(f"(async()=>{{const real=Date.now;Date.now=()=>Date.parse({json.dumps(self.data['generated_utc'])})+8*86400000;try{{await FixtureEvidence.validate({json.dumps(self.text)});return 'BAD'}}catch(e){{return e.message}}finally{{Date.now=real}}}})()")
        self.assertIn('stale', result)

    def test_unavailable_ui_clears_prior_pass_and_safe_text(self):
        b = self.browser
        for label, text in [('missing',''), ('malformed','{'), ('oversize','x'*(256*1024+1))]:
            b.js(f"document.getElementById('fixture-evidence').textContent={json.dumps(text)};loadFixtureEvidence()")
            b.wait("document.getElementById('evidence-status').dataset.state==='error'")
            self.assertEqual(b.js("document.querySelectorAll('[data-verdict]').length"), 0)
            self.assertEqual(b.js("document.getElementById('record-detail').textContent"), '')
            self.assertIn('No verdict on your draft', b.js("document.getElementById('evidence-status').textContent"))
            self.results.append({'case': 'UI '+label, 'cleared': True})
        text = '<img src=x onerror="window.__executed=true"><script>window.__executed=true</script>'
        self.assertTrue(b.js(f"(()=>{{const node=element('pre',{json.dumps(text)});document.getElementById('record-detail').append(node);return node.textContent==={json.dumps(text)} && node.children.length===0 && !window.__executed}})()"))
        b.js(f"document.getElementById('fixture-evidence').textContent={json.dumps(self.text)};loadFixtureEvidence()")
        b.wait("document.getElementById('evidence-status').dataset.state==='ready'")
        self.assertEqual(b.js("document.querySelectorAll('[data-verdict]').length"), 4)

    def test_forced_events_and_executable_draft_never_execute(self):
        b = self.browser
        original = b.js("document.getElementById('fixture-evidence').textContent")
        b.wait("!document.getElementById('save-status').textContent.startsWith('Opening')")
        # Real mouse and keyboard, then remove disabled attribute and force DOM events.
        for index in [0,1]:
            point = b.js(f"(()=>{{const e=document.querySelectorAll('.execution-actions button')[{index}];const r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}}}})()")
            for event in ['mousePressed','mouseReleased']:
                b.cdp('Input.dispatchMouseEvent', type=event, button='left', clickCount=1, **point)
            b.js(f"document.querySelectorAll('.execution-actions button')[{index}].disabled=false;document.querySelectorAll('.execution-actions button')[{index}].focus()")
            for key in ['Enter',' ']:
                for event in ['keyDown','keyUp']:
                    b.cdp('Input.dispatchKeyEvent', type=event, key=key)
            b.js(f"document.querySelectorAll('.execution-actions button')[{index}].click();document.querySelectorAll('.execution-actions button')[{index}].dispatchEvent(new Event('submit'));document.querySelectorAll('.execution-actions button')[{index}].disabled=true")
        draft = 'import os\nos.system("SHOULD_NEVER_RUN")\n<script>window.__executed=true</script>\n# café 日本語 🦊\n'
        b.js(f"document.getElementById('draft').value={json.dumps(draft)};document.getElementById('draft').dispatchEvent(new Event('input'));localStorage.setItem('fixture','correct');window.dispatchEvent(new StorageEvent('storage',{{key:'draft',newValue:'execute'}}))")
        b.wait("document.getElementById('save-status').dataset.state==='saved'")
        self.assertEqual(b.js("document.getElementById('fixture-evidence').textContent"), original)
        self.assertFalse(b.js('Boolean(window.__executed)'))
        self.assertTrue(b.js("typeof window.require==='undefined' && typeof window.ipcRenderer==='undefined' && document.querySelectorAll('iframe').length===0"))
        self.assertIn('unjudged', b.js("document.getElementById('save-status').textContent"))
        after_targets = b.cdp('Target.getTargets')['targetInfos']
        self.results.append({'case': 'targets after forced events', 'targets': after_targets})
        self.assertEqual({(t['targetId'], t['type'], t['url']) for t in after_targets},
                         {(t['targetId'], t['type'], t['url']) for t in self.targets})
        self.assertTrue(all(e['params']['request']['url'].startswith('file:') for e in b.events if e['method']=='Network.requestWillBeSent'))
        self.results.append({'case':'forced events/draft/storage', 'unchanged_evidence':True, 'editor_execution':False})
        theme = b.js('document.documentElement.dataset.theme')
        saved_record = b.js("new Promise(resolve=>{const o=indexedDB.open('mecode-poc-v1',1);o.onsuccess=()=>{const db=o.result,tx=db.transaction('workspace','readonly'),r=tx.objectStore('workspace').get('sum-array-v1');tx.oncomplete=()=>{db.close();resolve(r.result)}}})")
        pid = b.proc.pid
        metrics = b.close()
        self.assertTrue(metrics['clean_browser_close'] and metrics['exit_code'] == 0)
        fresh = chrome_pipe.ChromePipe('negative-fresh-readback')
        self.__class__.browser = fresh
        fresh.wait("document.getElementById('save-status').dataset.state==='saved'")
        fresh.wait("document.getElementById('evidence-status').dataset.state==='ready'")
        self.assertNotEqual(fresh.proc.pid, pid)
        self.assertEqual(fresh.js("document.getElementById('draft').value"), draft)
        self.assertEqual(fresh.js('document.documentElement.dataset.theme'), theme)
        self.assertEqual(fresh.js("document.getElementById('fixture-evidence').textContent"), original)
        self.assertIn('unjudged', fresh.js("document.getElementById('save-status').textContent"))
        restored = fresh.js("new Promise(resolve=>{const o=indexedDB.open('mecode-poc-v1',1);o.onsuccess=()=>{const db=o.result,tx=db.transaction('workspace','readonly'),r=tx.objectStore('workspace').get('sum-array-v1');tx.oncomplete=()=>{db.close();resolve(r.result)}}})")
        self.assertEqual(restored, saved_record)
        self.assertEqual(set(restored['current']), {'schemaVersion','problemId','draft','theme','revision','sha256'})
        self.results.append({'case':'executable-looking exact fresh-process readback', 'first_close':metrics, 'fresh_pid':fresh.proc.pid, 'exact_envelope':True, 'draft':draft, 'theme':theme})


if __name__ == '__main__':
    unittest.main(verbosity=2)
