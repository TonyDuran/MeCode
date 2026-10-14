"""Real Chrome155 headless regression suite; failure injection only through QA CDP."""
import hashlib
import json
import time
from datetime import datetime, timezone
from chrome_pipe import ChromePipe, OUT, URL
from runtime import ROOT, owned_bytes

STATUS = "document.getElementById('save-status')"
DRAFT = "document.getElementById('draft')"
DB = """new Promise((resolve,reject)=>{const r=indexedDB.open('mecode-poc-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('workspace');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);})"""
AUDIT = """(() => {
window.__qa={complete:[],abort:0,acks:[],stale:[],abortNext:false,throwNext:false,delayNext:false};
const state=window.__qa, records=new WeakMap();
const originalTx=IDBDatabase.prototype.transaction, originalPut=IDBObjectStore.prototype.put;
IDBDatabase.prototype.transaction=function(...args){
 const tx=originalTx.apply(this,args);
 if(args[1]==='readwrite'){
  const delay=state.delayNext;state.delayNext=false;
  tx.addEventListener('complete',()=>{const r=records.get(tx);if(r)state.complete.push({draft:r.current.draft,revision:r.current.revision,at:performance.now()})});
  tx.addEventListener('abort',()=>state.abort++);
  if(delay)Object.defineProperty(tx,'oncomplete',{set(handler){tx.addEventListener('complete',e=>setTimeout(()=>handler.call(tx,e),600))}});
 }
 return tx;
};
IDBObjectStore.prototype.put=function(value,key){
 if(state.throwNext){state.throwNext=false;throw new DOMException('Injected quota','QuotaExceededError');}
 records.set(this.transaction,value);
 const r=originalPut.call(this,value,key);
 if(state.abortNext){state.abortNext=false;this.transaction.abort();}
 return r;
};
new MutationObserver(()=>{
 const status=document.getElementById('save-status');
 if(status.dataset.state==='saved'){
  const last=state.complete.at(-1);
  state.acks.push({text:status.textContent,at:performance.now(),revision:last?.revision});
  if(!last || last.draft!==document.getElementById('draft').value)state.stale.push(status.textContent);
 }
}).observe(document.getElementById('save-status'),{childList:true});
})()"""

report = {'utc': datetime.now(timezone.utc).isoformat(), 'mode': 'headless; no headed claim', 'fixed_url': URL, 'checks': [], 'runs': [], 'screenshots': [], 'source_sha256': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['index.html','persistence.js','runtime.py','chrome_pipe.py','test_app.py','styles.css','app-styles.css','app.js','evidence-contract.js','evidence.js','workspace.html.in']}}
browser = None

def check(name, condition, evidence=None):
    row = {'name': name, 'passed': bool(condition)}
    if evidence is not None:
        row['evidence'] = evidence
    report['checks'].append(row)
    assert condition, row

def start(label):
    global browser
    assert browser is None
    browser = ChromePipe(label)
    browser.wait(f"{STATUS}.dataset.state && !{STATUS}.textContent.startsWith('Opening')")
    return browser

def close():
    global browser
    metrics = browser.close()
    report['runs'].append(metrics)
    browser = None
    check('clean browser exit / ' + str(metrics['pid']), metrics['clean_browser_close'] and metrics['exit_code'] == 0, metrics)

def record(operation='read', value=None):
    action = "const r=s.get('sum-array-v1');tx.oncomplete=()=>{db.close();resolve(r.result)}"
    if operation == 'put':
        action = f"s.put({json.dumps(value)},'sum-array-v1');tx.oncomplete=()=>{{db.close();resolve(true)}}"
    elif operation == 'delete':
        action = "s.delete('sum-array-v1');tx.oncomplete=()=>{db.close();resolve(true)}"
    mode = 'readonly' if operation == 'read' else 'readwrite'
    return browser.js(f"(async()=>{{const db=await {DB};return await new Promise((resolve,reject)=>{{const tx=db.transaction('workspace','{mode}');const s=tx.objectStore('workspace');{action};tx.onabort=()=>reject(tx.error)}})}})()")

def reload():
    browser.js('window.__reloadMarker=true')
    browser.cdp('Page.reload')
    browser.wait("typeof window.__reloadMarker==='undefined' && document.readyState==='complete'")
    browser.wait(f"{STATUS} && {STATUS}.dataset.state && !{STATUS}.textContent.startsWith('Opening')")

def edit(text, wait=True):
    browser.js(f"{DRAFT}.value={json.dumps(text)};{DRAFT}.dispatchEvent(new Event('input'))")
    if wait:
        browser.wait(f"{STATUS}.dataset.state==='saved'")

def saved():
    browser.wait(f"{STATUS}.dataset.state==='saved'")

def key(name, **extra):
    down = dict(extra)
    if name in ['Enter', ' ']:
        down['text'] = '\r' if name == 'Enter' else ' '
    browser.cdp('Input.dispatchKeyEvent', type='keyDown', key=name, **down)
    browser.cdp('Input.dispatchKeyEvent', type='keyUp', key=name, **extra)

try:
    start('app-initial')
    # Explicit QA-only fixed-key reset after the prerequisite, not profile deletion.
    record('delete'); reload()
    check('new profile state has no false acknowledgement', browser.js(f"{STATUS}.dataset.state!=='saved'"))
    key('Tab', code='Tab', windowsVirtualKeyCode=9)
    check('first Tab exposes skip link', browser.js("document.activeElement.classList.contains('skip') && document.activeElement.getBoundingClientRect().top>=0"))
    key('Enter', code='Enter', windowsVirtualKeyCode=13)
    check('keyboard skip reaches editable draft', browser.js("document.activeElement.id==='draft' && !document.activeElement.disabled"))
    browser.js(AUDIT)
    text = 'def solve(nums):\n    # café — 日本語 🦊\n    return sum(nums)\n\n'
    edit(text)
    browser.js("document.getElementById('theme').click()")
    saved()
    first = record()
    check('Unicode/multiline exact save and light theme', first['current']['draft'] == text and first['current']['theme'] == 'light', first)
    check('ack only after real completion, no stale ack', browser.js('__qa.complete.length>=2 && __qa.stale.length===0'), browser.js('__qa'))
    browser.screenshot('demo-01-edited-saved.png')
    close()
    start('app-fresh-reopen')
    readback = {'draft': browser.js(f'{DRAFT}.value'), 'theme': browser.js('document.documentElement.dataset.theme'), 'record': record(), 'status': browser.js(f'{STATUS}.textContent')}
    check('fresh process exact draft/theme/envelope readback', readback['draft'] == text and readback['theme'] == 'light' and readback['record'] == first, readback)
    check('distinct new browser PID', report['runs'][0]['pid'] != browser.proc.pid)
    browser.screenshot('demo-02-fresh-reopen.png')
    edit('')
    browser.js("document.getElementById('theme').click()")
    saved()
    empty = record()
    check('empty draft persisted, dark theme', empty['current']['draft'] == '' and empty['current']['theme'] == 'dark', empty)
    close()
    start('app-empty-reopen')
    check('empty exact fresh process readback', browser.js(f'{DRAFT}.value') == '' and browser.js('document.documentElement.dataset.theme') == 'dark' and record() == empty)
    browser.js(AUDIT)
    browser.js('__qa.abortNext=true')
    edit('unsaved after injected transaction abort 🦊', wait=False)
    browser.wait(f"{STATUS}.dataset.state==='error'")
    check('aborted write preserves text, previous acknowledged record, no saved ack', browser.js(f"{DRAFT}.value==='unsaved after injected transaction abort 🦊' && !document.getElementById('retry-save').hidden && __qa.abort===1 && __qa.acks.length===0") and record() == empty, browser.js(f"({{status:{STATUS}.textContent,audit:__qa}})"))
    check('unsaved abort requests unload warning', browser.js("(() => {const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()"))
    browser.screenshot('failure-aborted-write.png')
    browser.js("document.getElementById('retry-save').click()")
    saved()
    check('completed save has no unsaved unload warning', browser.js("(() => {const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return !e.defaultPrevented})()"))
    check('explicit retry saves retained text', record()['current']['draft'] == 'unsaved after injected transaction abort 🦊')
    before_quota = record()
    browser.js('__qa.throwNext=true')
    edit('unsaved quota text', wait=False)
    browser.wait(f"{STATUS}.dataset.state==='error'")
    check('synchronous quota exception aborts, does not false-ack', record() == before_quota and browser.js(f"{DRAFT}.value==='unsaved quota text' && __qa.stale.length===0"))
    browser.js("document.getElementById('retry-save').click()")
    saved()
    # Failed theme write retains selected theme but not a false save.
    before_theme_failure = record()
    browser.js('__qa.abortNext=true;document.getElementById("theme").click()')
    browser.wait(f"{STATUS}.dataset.state==='error'")
    check('failed theme write keeps unsaved selection and stored theme unchanged', record() == before_theme_failure and browser.js('document.documentElement.dataset.theme') != before_theme_failure['current']['theme'])
    browser.js("document.getElementById('retry-save').click()")
    saved()
    check('theme retry acknowledged only after completion', record()['current']['theme'] == browser.js('document.documentElement.dataset.theme') and browser.js('__qa.stale.length===0'))
    # Exact byte cap, then one extra UTF-8 byte; no truncation.
    browser.js(f"{DRAFT}.value='🦊'.repeat(262144);{DRAFT}.dispatchEvent(new Event('input'))")
    saved()
    check('exact 1 MiB UTF-8 accepted', browser.js(f"new TextEncoder().encode({DRAFT}.value).length===1048576") and len(record()['current']['draft'].encode()) == 1048576)
    boundary = record()['current']['sha256']
    browser.js(f"{DRAFT}.value+='x';{DRAFT}.dispatchEvent(new Event('input'))")
    browser.wait(f"{STATUS}.dataset.state==='error'")
    check('1 MiB + 1 byte rejected visibly, unsaved text not truncated', browser.js(f"new TextEncoder().encode({DRAFT}.value).length===1048577 && {STATUS}.textContent.includes('1 MiB UTF-8')") and record()['current']['sha256'] == boundary)
    edit('small draft after cap rejection')
    # Delay delivery of completion to the app, edit while old save is in flight.
    browser.js('__qa.delayNext=true')
    edit('older in-flight draft', wait=False)
    browser.wait("__qa.complete.at(-1)?.draft==='older in-flight draft'")
    check('ack withheld before completion handler delivery', browser.js(f"{STATUS}.dataset.state!=='saved'"))
    edit('newest draft 🦊', wait=False)
    time.sleep(.4)
    check('old completion cannot acknowledge newer edit', browser.js(f"{STATUS}.dataset.state!=='saved'"))
    saved()
    check('serialized newer save eventually acknowledged exactly', record()['current']['draft'] == 'newest draft 🦊' and browser.js('__qa.stale.length===0'), browser.js("({complete:__qa.complete.map(x=>({revision:x.revision,at:x.at,bytes:new TextEncoder().encode(x.draft).length})),acks:__qa.acks,stale:__qa.stale})"))
    # Layout/keyboard, both themes/viewports, recorded data untouched.
    for width, height in [(1440,900),(1024,768)]:
        browser.cdp('Emulation.setDeviceMetricsOverride',width=width,height=height,deviceScaleFactor=1,mobile=False)
        for theme in ['dark','light']:
            if browser.js('document.documentElement.dataset.theme') != theme:
                browser.js("document.getElementById('theme').click()"); saved()
            browser.js("document.getElementById('record-action').focus()")
            if browser.js("document.getElementById('record-action').getAttribute('aria-expanded')") == 'true':
                key('Enter',code='Enter',windowsVirtualKeyCode=13)
            key('Enter',code='Enter',windowsVirtualKeyCode=13)
            check(f'keyboard Enter opens recorded inspector {width}/{theme}', browser.js("document.getElementById('record-action').getAttribute('aria-expanded')==='true'"))
            key('Tab',code='Tab',windowsVirtualKeyCode=9)
            check(f'Tab reaches verdict {width}/{theme}', browser.js("document.activeElement.hasAttribute('data-verdict')"), browser.js('document.activeElement.outerHTML'))
            key(' ',code='Space',windowsVirtualKeyCode=32)
            browser.js("document.getElementById('draft').focus()")
            browser.cdp('Input.insertText', text='\n# keyboard 🦊')
            saved()
            key('Tab',code='Tab',windowsVirtualKeyCode=9,modifiers=8)
            check(f'Shift+Tab exits draft {width}/{theme}', browser.js("document.activeElement.id!=='draft'"), browser.js('document.activeElement.outerHTML'))
            geometry = browser.js("(() => {const ids=['draft','theme','save-status','execution-note','record-action'];const rects=ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {id,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}});return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,rects}})()")
            check(f'viewport usable {width}x{height}/{theme}', geometry['width'] == width and geometry['height'] == height and geometry['scroll'] <= width and all(r['width']>0 and r['height']>0 and r['x']>=0 and r['right']<=width and r['y']>=0 and r['bottom']<=height for r in geometry['rects']), geometry)
            name = f'final-{width}x{height}-{theme}.png'
            browser.screenshot(name); report['screenshots'].append(name)
    check('Run/Submit disabled, recorded inspector honest', browser.js("Array.from(document.querySelectorAll('.execution-actions button')).every(b=>b.disabled) && document.getElementById('execution-note').textContent==='Edited code is not run; isolation unavailable.' && document.querySelector('.record-warning').textContent.includes('Fixture demonstration, not your submission')"))
    check('no external requests under offline emulation', all(e['params']['request']['url'].startswith('file:') for e in browser.events if e['method']=='Network.requestWillBeSent'), [e['params']['request']['url'] for e in browser.events if e['method']=='Network.requestWillBeSent'])
    check('no browser script/console/CSP errors', not [e for e in browser.events if e['method']=='Runtime.exceptionThrown' or (e['method']=='Log.entryAdded' and e['params']['entry']['level']=='error')])
    healthy = record()
    broken = json.loads(json.dumps(healthy)); broken['current']['draft'] = 'corrupted without checksum update'
    record('put', broken); reload()
    check('corrupt current detected, explicit valid prior offered, data preserved', browser.js(f"{STATUS}.dataset.state==='error' && !document.getElementById('recover-prior').hidden") and record() == broken)
    browser.screenshot('failure-corrupt-current.png')
    browser.js("document.getElementById('recover-prior').click()")
    saved()
    recovered = record()
    check('explicit recovery uses prior and archives damaged snapshots atomically', recovered['current']['draft'] == healthy['previous']['draft'] and recovered['current']['theme'] == healthy['previous']['theme'] and recovered['quarantine'] == {'current':broken['current'],'previous':broken['previous']} and browser.js(f'{DRAFT}.value') == healthy['previous']['draft'], recovered)
    close()
    start('app-recovery-reopen')
    check('recovered snapshot survives fresh process and archive retained', record() == recovered and browser.js(f'{DRAFT}.value') == recovered['current']['draft'])
    # Independent corrupt-prior scenario, then no valid snapshot scenario.
    broken_prior = json.loads(json.dumps(healthy)); broken_prior['previous']['theme'] = 'invalid-theme'
    record('put', broken_prior); reload()
    check('corrupt prior blocks saving even with valid current, no recovery claim', browser.js(f"{STATUS}.dataset.state==='error' && document.getElementById('recover-prior').hidden && {DRAFT}.value==={json.dumps(healthy['current']['draft'])}") and record() == broken_prior)
    both = json.loads(json.dumps(broken_prior)); both['current']['revision'] = -1
    record('put', both); reload()
    check('both corrupt: no silent reset or prior recovery', browser.js(f"{STATUS}.dataset.state==='error' && document.getElementById('recover-prior').hidden && document.getElementById('storage-notice').textContent.includes('No recoverable')") and record() == both)
    browser.screenshot('failure-both-corrupt.png')
    future = json.loads(json.dumps(healthy)); future['schemaVersion'] = 99
    record('put', future); reload()
    check('unknown envelope schema fails closed without lossy recovery', browser.js(f"{STATUS}.dataset.state==='error' && document.getElementById('recover-prior').hidden") and record() == future)
    bad_archive = json.loads(json.dumps(healthy)); bad_archive['quarantine'] = False
    record('put', bad_archive); reload()
    check('malformed archive preserved without replacement or recovery', browser.js(f"{STATUS}.dataset.state==='error' && document.getElementById('recover-prior').hidden") and record() == bad_archive)
    # Preserve reviewed healthy demo test state, explicit QA replacement only.
    record('put', recovered); reload()
    saved(); close()
    report['passed'] = True
except Exception as error:
    report['passed'] = False
    report['error'] = repr(error)
    if browser:
        try: browser.screenshot('test-failure.png')
        except Exception: pass
    raise
finally:
    if browser:
        try: close()
        except Exception as error: report['cleanup_error'] = repr(error)
    report['owned_allocated_bytes_at_end'] = owned_bytes()
    (OUT / 'app-tests.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': report.get('passed'), 'checks_passed': sum(x['passed'] for x in report['checks']), 'checks_total':len(report['checks']), 'error':report.get('error'), 'runs':len(report['runs']), 'report':str(OUT/'app-tests.json')}, indent=2))
