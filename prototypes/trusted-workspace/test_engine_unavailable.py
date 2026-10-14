"""ENGINE-UNAVAILABLE-UX-1: static boundary and real headless DOM/AX receipts.
No fixture refresh, engine probe or historical state reuse.
"""
import hashlib
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

import chrome_pipe
import generate
from runtime import ROOT, STATE

NOTICE = ('Run and Submit are unavailable in this prototype. Live judging is not '
          'integrated or verified. Edit your draft; check save status above. It has not been judged.')
RECORD = """new Promise(resolve=>{const o=indexedDB.open('mecode-poc-v1',1);o.onsuccess=()=>{const db=o.result,tx=db.transaction('workspace','readonly'),r=tx.objectStore('workspace').get('sum-array-v1');tx.oncomplete=()=>{db.close();resolve(r.result)}}})"""


class StaticNotice(unittest.TestCase):
    def test_notice_and_generated_page(self):
        template = (ROOT/'workspace.html.in').read_text()
        text = (ROOT/'fixture-evidence.json').read_text()
        self.assertEqual((ROOT/'index.html').read_text(), template.replace('@@EVIDENCE@@', text))
        self.assertEqual(template.count('id="execution-note"'), 1)
        self.assertIn(NOTICE, template)
        for action in ['run-draft', 'submit-draft']:
            self.assertIn(f'<button id="{action}" disabled aria-describedby="execution-note">', template)
        for name in ['app.js', 'run-ui.js', 'persistence.js', 'evidence.js', 'workspace.html.in']:
            source = (ROOT/name).read_text()
            for token in ['controller', 'subprocess', 'socket', 'fetch(', 'XMLHttpRequest',
                          'WebSocket', 'ipcRenderer', 'child_process', 'import(', 'onsubmit=']:
                self.assertNotIn(token, source, (name, token))
        # The slice must not add a Run/Submit handler or learner verdict/progress field.
        self.assertNotIn('execution-actions', (ROOT/'app.js').read_text())
        self.assertNotIn('execution-actions', (ROOT/'persistence.js').read_text())

    def test_render_existing_preserves_evidence_without_launch(self):
        before = {name: (ROOT/name).read_bytes() for name in
                  ['fixture-evidence.json', 'evidence-contract.js', 'index.html']}
        with patch.object(generate, 'Guard') as guard, patch.object(generate.importlib.util, 'spec_from_file_location') as loader, patch.object(Path, 'write_text') as write:
            generate.render_existing()
            guard.assert_not_called()
            loader.assert_not_called()
            write.assert_called_once_with(before['index.html'].decode())
        for name, data in before.items():
            self.assertEqual((ROOT/name).read_bytes(), data)
        with patch.dict(generate.HASHES, {'runner.py': '0'*64}), patch.object(Path, 'write_text') as write:
            with self.assertRaisesRegex(RuntimeError, 'identity differs'):
                generate.render_existing()
            write.assert_not_called()


class BrowserNotice(unittest.TestCase):
    def test_notice_actions_themes_failure_and_fresh_reopen(self):
        base = STATE/'ux'
        base.mkdir(exist_ok=False)
        chrome_pipe.BASE = base
        chrome_pipe.OUT = STATE/'ux-report'
        report = {'source_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in ROOT.iterdir() if p.is_file()}, 'checks': [], 'runs': [],
                  'mode': 'headless; no headed claim'}
        b = None

        def snapshot():
            assert b is not None
            return b.js("({fixture:document.getElementById('fixture-evidence').textContent,detail:document.getElementById('record-detail').textContent,warning:document.querySelector('.record-warning').textContent,status:document.getElementById('draft-status').textContent,verdicts:Array.from(document.querySelectorAll('[data-verdict]')).map(e=>[e.textContent,e.getAttribute('aria-pressed')])})")

        def notice(label):
            assert b is not None
            state = b.js("({text:document.getElementById('execution-note').textContent,buttons:Array.from(document.querySelectorAll('.execution-actions button')).map(e=>({name:e.textContent,disabled:e.disabled,description:e.getAttribute('aria-describedby')}))})")
            self.assertEqual(state['text'], NOTICE)
            self.assertEqual(state['buttons'], [{'name': n, 'disabled': True, 'description': 'execution-note'} for n in ['Run', 'Submit']])
            nodes = b.cdp('Accessibility.getFullAXTree')['nodes']
            controls = [n for n in nodes if n.get('role', {}).get('value') == 'button' and n.get('name', {}).get('value') in ['Run', 'Submit']]
            self.assertEqual(len(controls), 2)
            for n in controls:
                self.assertFalse(n.get('ignored'))
                self.assertEqual(n['description']['value'], NOTICE)
                self.assertTrue(any(p['name'] == 'disabled' and p['value']['value'] is True for p in n['properties']))
            self.assertTrue(any(n.get('role', {}).get('value') == 'StaticText' and n.get('name', {}).get('value') == NOTICE and not n.get('ignored') for n in nodes))
            report['checks'].append({'label': label, 'dom': state, 'ax_controls': controls})

        def visible(label):
            assert b is not None
            geometry = b.js("(() => {const ids=['execution-note','save-status','draft'];const rects=ids.map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {id,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,color:s.color,background:s.backgroundColor,font:s.fontSize,display:s.display,visibility:s.visibility}});return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,rects}})()")
            self.assertLessEqual(geometry['scroll'], geometry['width'])
            for r in geometry['rects']:
                self.assertGreater(r['width'], 0)
                self.assertGreater(r['height'], 0)
                self.assertGreaterEqual(r['x'], 0)
                self.assertGreaterEqual(r['y'], 0)
                self.assertLessEqual(r['right'], geometry['width'])
                self.assertLessEqual(r['bottom'], geometry['height'])
                self.assertNotEqual(r['display'], 'none')
                self.assertEqual(r['visibility'], 'visible')
            self.assertLessEqual(geometry['rects'][1]['bottom'], geometry['rects'][0]['y'])
            # Viewport bounds alone miss clipping by the editor's overflow box.
            self.assertTrue(b.js("(() => {const e=document.getElementById('execution-note'),r=e.getBoundingClientRect(),p=e.closest('.editor').getBoundingClientRect();return r.top>=p.top && r.bottom<=p.bottom && document.elementFromPoint(r.left+2,r.bottom-2)===e})()"), 'notice clipped by editor or covered by inspector')
            b.screenshot(label+'.png')
            report['checks'].append({'label': label, 'geometry': geometry})

        def close():
            nonlocal b
            assert b is not None
            metrics = b.close()
            b = None
            report['runs'].append(metrics)
            self.assertTrue(metrics['clean_browser_close'])
            self.assertEqual(metrics['exit_code'], 0)

        try:
            b = chrome_pipe.ChromePipe('ux-open')
            b.wait("!document.getElementById('save-status').textContent.startsWith('Opening')")
            b.wait("document.getElementById('evidence-status').dataset.state==='ready'")
            self.assertIsNone(b.js(RECORD))
            notice('initial-open')
            draft = 'def solve(nums):\n    # café 日本語 🦊 — still unjudged\n    return sum(nums)\n'
            b.js(f"document.getElementById('draft').value={json.dumps(draft)};document.getElementById('draft').dispatchEvent(new Event('input'))")
            b.wait("document.getElementById('save-status').dataset.state==='saved'")
            for width, height in [(1440, 900), (1024, 768)]:
                b.cdp('Emulation.setDeviceMetricsOverride', width=width, height=height, deviceScaleFactor=1, mobile=False)
                for theme in ['dark', 'light']:
                    if b.js('document.documentElement.dataset.theme') != theme:
                        b.js("document.getElementById('theme').click()")
                        b.wait("document.getElementById('save-status').dataset.state==='saved'")
                    notice(f'{width}-{theme}')
                    visible(f'ux-{width}-{theme}')
            stored, evidence = b.js(RECORD), snapshot()
            targets = b.cdp('Target.getTargets')['targetInfos']
            # Actual mouse on disabled controls, forced DOM click and key events,
            # then QA removes disabled to prove there is no latent action route.
            for index in [0, 1]:
                point = b.js(f"(() => {{const e=document.querySelectorAll('.execution-actions button')[{index}],r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}}}})()")
                for event in ['mousePressed', 'mouseReleased']:
                    b.cdp('Input.dispatchMouseEvent', type=event, button='left', clickCount=1, **point)
                b.js(f"(() => {{const e=document.querySelectorAll('.execution-actions button')[{index}];e.focus();e.click();for(const k of ['Enter',' ']){{e.dispatchEvent(new KeyboardEvent('keydown',{{key:k,bubbles:true}}));e.dispatchEvent(new KeyboardEvent('keyup',{{key:k,bubbles:true}}));}}e.dispatchEvent(new MouseEvent('click',{{bubbles:true}}));e.dispatchEvent(new Event('submit',{{bubbles:true}}));e.disabled=false;e.focus();}})()")
                for key, code, vk in [('Enter', 'Enter', 13), (' ', 'Space', 32)]:
                    b.cdp('Input.dispatchKeyEvent', type='keyDown', key=key, code=code, windowsVirtualKeyCode=vk, text='\r' if key == 'Enter' else ' ')
                    b.cdp('Input.dispatchKeyEvent', type='keyUp', key=key, code=code, windowsVirtualKeyCode=vk)
                b.js(f"document.querySelectorAll('.execution-actions button')[{index}].click();document.querySelectorAll('.execution-actions button')[{index}].disabled=true")
            time.sleep(.4)
            self.assertEqual(b.js(RECORD), stored)
            self.assertEqual(snapshot(), evidence)
            self.assertEqual(b.cdp('Target.getTargets')['targetInfos'], targets)
            self.assertEqual(set(stored['current']), {'schemaVersion','problemId','draft','theme','revision','sha256'})
            self.assertIn('not your submission', evidence['warning'])
            self.assertIn('not run', evidence['status'])
            self.assertTrue(all(e['params']['request']['url'].startswith('file:') for e in b.events if e['method'] == 'Network.requestWillBeSent'))
            report['checks'].append({'label': 'forced-events-no-execution-result-attempt-progress', 'unchanged_record': stored, 'unchanged_inspector': evidence, 'targets': targets})
            first_pid = b.proc.pid
            close()
            b = chrome_pipe.ChromePipe('ux-fresh-reopen')
            b.wait("document.getElementById('save-status').dataset.state==='saved'")
            b.wait("document.getElementById('evidence-status').dataset.state==='ready'")
            self.assertNotEqual(b.proc.pid, first_pid)
            self.assertEqual(b.js(RECORD), stored)
            self.assertEqual(b.js("document.getElementById('draft').value"), draft)
            self.assertEqual(b.js('document.documentElement.dataset.theme'), 'light')
            self.assertEqual(snapshot(), evidence)
            notice('fresh-process-reopen')
            visible('ux-reopen-light')
            # Real transaction abort: notice cannot replace or obscure unsaved feedback.
            b.js("(() => {const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){IDBObjectStore.prototype.put=put;const r=put.apply(this,args);this.transaction.abort();return r;};document.getElementById('draft').value+='unsaved';document.getElementById('draft').dispatchEvent(new Event('input'));})()")
            b.wait("document.getElementById('save-status').dataset.state==='error'")
            self.assertEqual(b.js(RECORD), stored)
            self.assertIn('Not saved', b.js("document.getElementById('save-status').textContent"))
            notice('save-failure')
            visible('ux-save-failure')
            b.js("document.getElementById('retry-save').click()")
            b.wait("document.getElementById('save-status').dataset.state==='saved'")
            self.assertEqual(b.js(RECORD)['current']['draft'], draft+'unsaved')
            self.assertEqual(snapshot()['fixture'], evidence['fixture'])
            notice('save-retry')
            close()
            report['passed'] = True
        except Exception as error:
            report['passed'] = False
            report['error'] = repr(error)
            raise
        finally:
            if b is not None:
                close()
            (chrome_pipe.OUT/'ux-tests.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')


PUT_RECORD = """new Promise(resolve=>{const o=indexedDB.open('mecode-poc-v1',1);o.onsuccess=()=>{const db=o.result,tx=db.transaction('workspace','readwrite'),st=tx.objectStore('workspace'),r=st.get('sum-array-v1');r.onsuccess=()=>{const v=r.result;v.previous.sha256='0'.repeat(64);st.put(v,'sum-array-v1')};tx.oncomplete=()=>{db.close();resolve(true)}}})"""


class BrowserCorruptLayout(unittest.TestCase):
    """QA-UX-1: corrupt-prior fresh reopen at 1024x768 must show everything initially."""

    def run_theme(self, theme):
        base = STATE/f'corrupt-{theme}'
        base.mkdir(exist_ok=False)
        chrome_pipe.BASE = base
        chrome_pipe.OUT = STATE/'corrupt-report'
        b = chrome_pipe.ChromePipe(f'corrupt-{theme}-seed')
        try:
            b.wait("!document.getElementById('save-status').textContent.startsWith('Opening')")
            for text in ['first draft', 'second draft']:
                b.js(f"document.getElementById('draft').value={json.dumps(text)};document.getElementById('draft').dispatchEvent(new Event('input'))")
                b.wait(f"document.getElementById('save-status').dataset.state==='saved' && {json.dumps(text)}===document.getElementById('draft').value")
                time.sleep(.2)
            if b.js('document.documentElement.dataset.theme') != theme:
                b.js("document.getElementById('theme').click()")
                b.wait(f"document.documentElement.dataset.theme==={json.dumps(theme)} && document.getElementById('save-status').dataset.state==='saved'")
            self.assertTrue(b.js(PUT_RECORD))
        finally:
            self.assertTrue(b.close()['clean_browser_close'])
        b = chrome_pipe.ChromePipe(f'corrupt-{theme}-reopen')
        try:
            b.cdp('Emulation.setDeviceMetricsOverride', width=1024, height=768, deviceScaleFactor=1, mobile=False)
            b.wait("document.getElementById('save-status').dataset.state==='error'")
            self.assertEqual(b.js('document.documentElement.dataset.theme'), theme)
            b.screenshot(f'corrupt-{theme}-initial.png')
            geo = b.js("(() => {const q=id=>document.getElementById(id),ed=q('execution-note').closest('.editor'),E=ed.getBoundingClientRect(),r=id=>{const x=q(id).getBoundingClientRect();return {id,top:x.top,bottom:x.bottom,inside:x.top>=E.top&&x.bottom<=E.bottom}};return {scrollTop:ed.scrollTop,overflow:ed.scrollHeight-ed.clientHeight,editorBottom:E.bottom,textarea:q('draft').getBoundingClientRect().height,parts:['save-status','storage-notice','execution-note'].map(r),buttons:Array.from(document.querySelectorAll('.execution-actions button')).map(e=>e.disabled),noticeText:q('execution-note').textContent,status:q('save-status').textContent}})()")
            self.assertEqual(geo['scrollTop'], 0)
            self.assertLessEqual(geo['overflow'], 0, geo)
            for part in geo['parts']:
                self.assertTrue(part['inside'], ('clipped', part, geo['editorBottom']))
            self.assertGreaterEqual(geo['textarea'], 60, geo)
            self.assertEqual(geo['buttons'], [True, True])
            self.assertIn('automatic saving blocked', geo['status'])
        finally:
            self.assertTrue(b.close()['clean_browser_close'])

    def test_dark_initial_reopen_fully_visible(self):
        self.run_theme('dark')

    def test_light_initial_reopen_fully_visible(self):
        self.run_theme('light')


if __name__ == '__main__':
    unittest.main(verbosity=2)
