"""Themis-owned retained R1 regression; implementation is never edited.
Goal: expose accepted-input loss at real recovery await boundaries.
Affected additions: this test and exclusively new test-data/themis-* paths.
Success: recovery excludes input or preserves accepted input with truthful status;
failed recovery retains the damaged record, text, and appropriate editability.
Risk: QA fixed-key corruption, held delivery and transaction abort are confined to
fresh SHORT browser profiles. No editor execution, installs or network listener.
Run with an explicit current SOURCE-SHA256.txt digest; changed revisions require a
new binding and tag. Exit 1 is an assertion failure; setup exceptions are ERRORS.
"""
import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import unittest

import chrome_pipe
from runtime import ROOT, STATE

DRAFT = "document.getElementById('draft')"
STATUS = "document.getElementById('save-status')"
NEW = 'THEMIS NEW EDIT AFTER RECOVERY CLICK 🦊\nsecond line café 日本語'
PRIOR = 'themis prior valid draft 🦊'
CURRENT = 'themis current valid draft'
REPORT = {'utc': datetime.now(timezone.utc).isoformat(), 'cases': [], 'runs': []}

HASH_HOLD = """(() => {
 const original=crypto.subtle.digest.bind(crypto.subtle);
 window.__themis={ready:false,released:false,complete:false,delivered:false};
 crypto.subtle.digest=async(...args)=>{
   crypto.subtle.digest=original;
   const actual=await original(...args);
   return await new Promise(resolve=>{
     __themis.ready=true;
     window.__themisRelease=()=>{__themis.released=true;resolve(actual)};
   });
 };
})()"""
COMPLETE_HOLD = """(() => {
 const original=IDBDatabase.prototype.transaction;
 window.__themis={ready:false,released:false,complete:false,delivered:false};
 IDBDatabase.prototype.transaction=function(...args){
   const tx=original.apply(this,args);
   if(args[1]==='readwrite'){
     IDBDatabase.prototype.transaction=original;
     tx.addEventListener('complete',()=>{__themis.complete=true});
     Object.defineProperty(tx,'oncomplete',{set(handler){
       tx.addEventListener('complete',event=>{
         __themis.ready=true;
         window.__themisRelease=()=>{
           __themis.released=true;
           handler.call(tx,event);
           __themis.delivered=true;
         };
       });
     }});
   }
   return tx;
 };
})()"""
ABORT_PUT = """(() => {
 const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){
   IDBObjectStore.prototype.put=original;
   const request=original.apply(this,args);
   this.transaction.abort();
   __themis.aborted=true;
   return request;
 };
})()"""


def manifest_check(name):
    rows = []
    for line in (ROOT/name).read_text().splitlines():
        expected, relative = line.split('  ', 1)
        actual = hashlib.sha256((ROOT/relative).read_bytes()).hexdigest()
        rows.append({'path': relative, 'expected': expected, 'actual': actual})
    return {'entries': len(rows), 'mismatches': [r for r in rows if r['actual'] != r['expected']]}


def owned_processes(bases):
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            args = (proc/'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            if 'chrome' in args and any(str(base) in args for base in bases):
                found.append({'pid': int(proc.name), 'command': args})
        except OSError:
            pass
    return found


class RecoveryRegression(unittest.TestCase):
    def state(self):
        return self.b.js(f"({{draft:{DRAFT}.value,disabled:{DRAFT}.disabled,status:{STATUS}.textContent,state:{STATUS}.dataset.state,recoveryDisabled:document.getElementById('recover-prior').disabled,recoveryHidden:document.getElementById('recover-prior').hidden}})")

    def record(self, value=None):
        mode = 'readonly' if value is None else 'readwrite'
        operation = "const request=s.get('sum-array-v1');tx.oncomplete=()=>{db.close();resolve(request.result)}" if value is None else f"s.put({json.dumps(value)},'sum-array-v1');tx.oncomplete=()=>{{db.close();resolve(true)}}"
        return self.b.js(f"new Promise((resolve,reject)=>{{const o=indexedDB.open('mecode-poc-v1',1);o.onsuccess=()=>{{const db=o.result;const tx=db.transaction('workspace','{mode}');const s=tx.objectStore('workspace');{operation};tx.onabort=()=>reject(tx.error)}};o.onerror=()=>reject(o.error)}})")

    def type_text(self, text):
        self.b.js(f"{DRAFT}.focus();{DRAFT}.select()")
        self.b.cdp('Input.insertText', text=text)

    def click(self, element_id):
        point = self.b.js(f"(() => {{const e=document.getElementById({json.dumps(element_id)});e.scrollIntoView({{block:'center'}});const r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}}}})()")
        for event in ['mousePressed', 'mouseReleased']:
            self.b.cdp('Input.dispatchMouseEvent', type=event, x=point['x'], y=point['y'], button='left', clickCount=1)

    def run_case(self, label, hold, abort=False):
        base = STATE / f'r1-{TAG}{label}'
        # Fail rather than reset, reuse, overwrite or touch someone else's profile.
        base.mkdir(exist_ok=False)
        BASES.append(base)
        chrome_pipe.BASE = base
        chrome_pipe.OUT = OUT
        self.b = None
        row = {'case': label, 'profile_base': str(base), 'hold': hold, 'abort': abort}
        REPORT['cases'].append(row)
        try:
            self.b = chrome_pipe.ChromePipe(f'r1-{label}')
            self.b.wait(f"{STATUS}.dataset.state && !{STATUS}.textContent.startsWith('Opening')")
            self.assertNotEqual(self.state()['state'], 'saved', 'SETUP: fresh profile falsely restored')
            for text in [PRIOR, CURRENT]:
                self.type_text(text)
                self.b.wait(f"{STATUS}.dataset.state==='saved'")
                self.assertEqual(self.record()['current']['draft'], text, 'SETUP: seed save failed')
            healthy = self.record()
            prior = healthy['previous']
            canonical = json.dumps([prior[k] for k in ['schemaVersion','problemId','draft','theme','revision']], ensure_ascii=False, separators=(',', ':'))
            self.assertEqual(prior['sha256'], hashlib.sha256(canonical.encode()).hexdigest(), 'SETUP: previous checksum invalid')
            broken = json.loads(json.dumps(healthy))
            broken['current']['sha256'] = '0' * 64
            row['healthy'] = healthy
            row['broken'] = broken
            self.record(broken)
            self.b.js('window.__themisReload=true')
            self.b.cdp('Page.reload')
            self.b.wait(f"!window.__themisReload && {STATUS} && {STATUS}.dataset.state==='error' && !document.getElementById('recover-prior').hidden")
            self.assertEqual(self.record(), broken, 'SETUP: corrupt data was not preserved')
            row['before'] = self.state()
            self.b.js(HASH_HOLD if hold == 'hash' else COMPLETE_HOLD)
            if abort:
                self.b.js(ABORT_PUT)
            self.click('recover-prior')
            self.b.wait('__themis.ready && typeof __themisRelease===\'function\'')
            row['pending_before_input'] = self.state()
            self.assertNotEqual(row['pending_before_input']['state'], 'saved', 'R1: acknowledgement delivered before held recovery completion')
            self.type_text(NEW)
            row['during'] = self.state()
            row['accepted_input'] = row['during']['draft'] == NEW
            self.b.screenshot(f'r1-{label}-pending.png')
            row['stored_before_release'] = self.record()
            row['hook_before_release'] = self.b.js('__themis')
            self.b.js('__themisRelease()')
            self.b.wait("document.getElementById('recover-prior').hidden || document.getElementById('save-status').textContent.startsWith('Recovery not saved')")
            row['after'] = self.state()
            row['stored_after_release'] = self.record()
            row['hook_after_release'] = self.b.js('__themis')
            row['lost_accepted_input'] = row['accepted_input'] and row['after']['draft'] != NEW
            row['misleading_saved_after_loss'] = row['lost_accepted_input'] and row['after']['state'] == 'saved'
            self.b.screenshot(f'r1-{label}-after.png')
            row['phase'] = 'production recovery finished; asserting R1 behavior'
            if abort:
                self.assertTrue(row['hook_after_release'].get('aborted'), 'SETUP: real abort not injected')
                self.assertEqual(row['stored_after_release'], broken, 'R1: failed recovery changed damaged record')
                self.assertEqual(row['after']['state'], 'error', 'R1: aborted recovery falsely saved')
                self.assertFalse(row['after']['disabled'], 'R1: failed recovery strands editor disabled')
                expected = NEW if row['accepted_input'] else row['before']['draft']
                self.assertEqual(row['after']['draft'], expected, 'R1: failed recovery lost current-session text')
            else:
                self.assertFalse(row['lost_accepted_input'], 'R1: recovery erased accepted post-click input and reported ' + row['after']['status'])
                if row['accepted_input']:
                    self.assertTrue(row['after']['state'] != 'saved' or row['stored_after_release']['current']['draft'] == NEW, 'R1: accepted input falsely acknowledged')
                else:
                    self.assertTrue(row['pending_before_input']['disabled'], 'R1: input neither accepted nor explicitly excluded')
                    self.assertEqual(row['after']['draft'], PRIOR)
                    self.assertFalse(row['after']['disabled'])
                    self.assertEqual(row['after']['state'], 'saved')
                self.assertEqual(row['stored_after_release']['quarantine'], {'current': broken['current'], 'previous': broken['previous']}, 'R1: damaged-pair archive lost')
            row['passed'] = True
        except AssertionError as exc:
            row['passed'] = False
            row['assertion'] = str(exc)
            raise
        except Exception as exc:
            row['setup_or_runtime_error'] = repr(exc)
            raise
        finally:
            if self.b is not None:
                REPORT['runs'].append(self.b.close())
                self.b = None

    def test_hash_delivery_excludes_or_preserves_new_input(self):
        self.run_case('h', 'hash')

    def test_transaction_completion_excludes_or_preserves_new_input(self):
        self.run_case('c', 'completion')

    def test_failed_recovery_retains_text_record_and_editability(self):
        self.run_case('f', 'hash', abort=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', required=True)
    parser.add_argument('--expected-source-manifest', required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-z0-9]{1,2}', args.tag) or not re.fullmatch('[0-9a-f]{64}', args.expected_source_manifest):
        parser.error('tag must be 1–2 lowercase alphanumerics; expected source digest must be exact lowercase SHA-256')
    TAG = args.tag
    actual = hashlib.sha256((ROOT/'SOURCE-SHA256.txt').read_bytes()).hexdigest()
    if actual != args.expected_source_manifest:
        parser.error('source manifest digest differs from explicit revision binding')
    REPORT['source_manifest_sha256'] = actual
    REPORT['source_files_sha256'] = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['persistence.js','runtime.py','chrome_pipe.py','index.html',Path(__file__).name]}
    REPORT['environment'] = {'python': sys.version, 'uname': list(os.uname()), 'DISPLAY': os.environ.get('DISPLAY'), 'WAYLAND_DISPLAY': os.environ.get('WAYLAND_DISPLAY')}
    REPORT['manifest_before'] = {name: manifest_check(name) for name in ['SOURCE-SHA256.txt','ARTIFACT-SHA256.txt']}
    if any(r['mismatches'] for r in REPORT['manifest_before'].values()):
        parser.error('sealed snapshot check failed; no tests started')
    OUT = STATE / f'r1-report-{TAG}'
    OUT.mkdir(exist_ok=False)
    BASES = []
    log = io.StringIO()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(RecoveryRegression)
    with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
        result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
    REPORT['summary'] = {'tests_run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'successful': result.wasSuccessful()}
    REPORT['manifest_after'] = {name: manifest_check(name) for name in ['SOURCE-SHA256.txt','ARTIFACT-SHA256.txt']}
    REPORT['remaining_owned_chrome_processes'] = owned_processes(BASES)
    REPORT['argv'] = sys.argv
    (OUT/'regression-output.txt').write_text(log.getvalue())
    (OUT/'regression.json').write_text(json.dumps(REPORT, ensure_ascii=False, indent=2)+'\n')
    print(log.getvalue(), end='')
    print(json.dumps({'report': str(OUT/'regression.json'), **REPORT['summary'], 'remaining_owned_chrome_processes': REPORT['remaining_owned_chrome_processes']}, indent=2))
    cleanup_ok = not REPORT['remaining_owned_chrome_processes'] and all(r['clean_browser_close'] and r['exit_code'] == 0 for r in REPORT['runs'])
    seals_ok = not any(r['mismatches'] for r in REPORT['manifest_after'].values())
    raise SystemExit(0 if result.wasSuccessful() and cleanup_ok and seals_ok else 1)
