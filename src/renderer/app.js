'use strict';
// Renderer: no node, text-only rendering (textContent), all host access via window.mecode.
const $ = (id) => document.getElementById(id);
const api = window.mecode;
const LANGS = { python: 'Python 3', javascript: 'JavaScript', cpp: 'C++17', c: 'C17' };
const S = { catalog: null, key: null, prob: null, lang: 'python', rev: 0, dirty: false, saveChain: Promise.resolve(), saveTimer: null, jobSeq: 0, curJob: null, backend: null };

function banner(msg) { const b = $('banner'); b.hidden = !msg; b.textContent = msg || ''; }
function errText(e) { return `${e.code}: ${e.message}` + (e.details ? '\n' + e.details.slice(0, 10).map((d) => `  ${d.file || ''} ${d.path}: ${d.message}`).join('\n') : ''); }

async function refreshBackend() {
  const r = await api.backend.status();
  if (!r.ok) return;
  S.backend = r.value;
  const v = r.value;
  $('backend').textContent = `backend: ${v.state}` + (v.reason ? ` — ${v.reason}` : '') + (v.state === 'ready' ? ` (${v.languages.map((l) => l.id).join(', ')})` : '');
  $('retry').hidden = !['unavailable'].includes(v.state);
  const canRun = v.state === 'ready' && !S.curJob && S.prob;
  for (const id of ['runEx', 'runCustom', 'submit']) $(id).disabled = !canRun;
  $('cancel').disabled = !S.curJob;
}

function renderList() {
  const q = $('search').value.toLowerCase();
  const ul = $('list'); ul.replaceChildren();
  for (const p of S.catalog.problems) {
    if (q && !(p.title.toLowerCase().includes(q) || p.patterns.join(' ').includes(q))) continue;
    const li = document.createElement('li');
    li.textContent = `[${p.status}] ${p.title} · ${p.difficulty} · ${p.patterns.join(', ')}`;
    if (p.key === S.key) li.className = 'sel';
    li.addEventListener('click', () => openProblem(p.key));
    ul.append(li);
  }
}

async function loadCatalog() {
  const r = await api.catalog.list();
  if (!r.ok) { banner(errText(r.error)); return; }
  S.catalog = r.value;
  const msgs = [];
  if (r.value.error) msgs.push(`Pack problem (last-good catalog in use): ${errText(r.value.error)}`);
  if (r.value.warning) msgs.push(r.value.warning);
  if (msgs.length) banner(msgs.join('\n'));
  renderList();
}

async function flushSave() {
  clearTimeout(S.saveTimer);
  if (!S.prob || !S.dirty) return S.saveChain;
  const key = S.key, lang = S.lang, source = $('editor').value;
  S.dirty = false; $('saveState').textContent = 'saving…';
  S.saveChain = S.saveChain.then(async () => {
    const r = await api.draft.save({ key, language: lang, source, baseRevision: S.revFor(key, lang) });
    if (r.ok) { S.setRev(key, lang, r.value.revision); if (S.key === key && S.lang === lang && !S.dirty) $('saveState').textContent = `saved (rev ${r.value.revision})`; }
    else { S.dirty = true; $('saveState').textContent = `SAVE FAILED: ${errText(r.error)}`; }
  });
  return S.saveChain;
}
const revs = new Map();
S.revFor = (k, l) => revs.get(`${k}|${l}`) || 0;
S.setRev = (k, l, v) => revs.set(`${k}|${l}`, v);

async function openProblem(key) {
  await flushSave();
  const r = await api.catalog.get({ key });
  if (!r.ok) { banner(errText(r.error)); return; }
  S.key = key; S.prob = r.value; S.curJob = null;
  $('work').hidden = false;
  $('title').textContent = r.value.title;
  $('meta').textContent = `${r.value.difficulty} · ${r.value.patterns.join(', ')} · ${r.value.provenance.kind} (${r.value.provenance.license}) · tests: ${r.value.examples.length} examples + ${r.value.checkCount} checks · hash ${r.value.contentHash.slice(0, 12)}`;
  $('statement').textContent = r.value.statement;
  $('formats').textContent = `Input:\n${r.value.inputFormat}\n\nOutput:\n${r.value.outputFormat}\n\nConstraints:\n- ${r.value.constraints.join('\n- ')}`;
  const ex = $('examples'); ex.replaceChildren();
  for (const t of r.value.examples) { const p = document.createElement('pre'); p.textContent = `Example ${t.id}\nstdin:\n${t.stdin}\nexpected:\n${t.expected}` + (t.explanation ? `\n${t.explanation}` : ''); ex.append(p); }
  const sel = $('lang'); sel.replaceChildren();
  for (const l of Object.keys(LANGS)) { const o = document.createElement('option'); o.value = l; o.textContent = LANGS[l]; sel.append(o); }
  const first = Object.keys(r.value.starters)[0] || 'python';
  S.lang = Object.keys(r.value.starters).includes(S.lang) ? S.lang : first;
  sel.value = S.lang;
  await loadDraft();
  $('verdict').textContent = 'No result yet'; $('verdict').className = ''; $('results').textContent = '';
  renderList(); refreshBackend();
}

async function loadDraft() {
  const d = await api.draft.load({ key: S.key, language: S.lang });
  const rev = d.ok ? d.value.revision : 0;
  S.setRev(S.key, S.lang, rev);
  $('editor').value = d.ok && d.value.source !== null ? d.value.source : (S.prob.starters[S.lang] || '');
  $('saveState').textContent = d.ok && d.value.source !== null ? `draft restored (rev ${rev})` : 'starter template (unsaved)';
  S.dirty = false;
}

async function execute(mode) {
  await flushSave();
  const mine = ++S.jobSeq; const key = S.key, hash = S.prob.contentHash;
  const r = await api.execution.start({ key, contentHash: hash, language: S.lang, source: $('editor').value, mode, customInput: $('custom').value });
  if (!r.ok) { $('verdict').textContent = `Could not start: ${errText(r.error)}`; $('verdict').className = 'INFRA_ERROR'; return; }
  S.curJob = r.value.jobId; refreshBackend();
  $('verdict').textContent = 'Running…'; $('verdict').className = ''; $('results').textContent = '';
  for (;;) {
    await new Promise((res) => setTimeout(res, 250));
    const g = await api.execution.get({ jobId: r.value.jobId });
    if (S.jobSeq !== mine || S.key !== key) { return; } // obsolete: do not paint over the current editor
    if (!g.ok) { $('verdict').textContent = errText(g.error); return; }
    if (g.value.state === 'done') { S.curJob = null; show(g.value.result); await loadCatalog(); refreshBackend(); return; }
  }
}

function show(res) {
  $('verdict').textContent = `${res.mode}: ${res.verdict}` + (res.message ? ` — ${res.message}` : '');
  $('verdict').className = res.verdict;
  const lines = [];
  if (res.compile) lines.push(`compile: ${res.compile.ok ? 'ok' : 'FAILED'}${res.compile.timedOut ? ' (timed out)' : ''}\n${res.compile.output}`);
  for (const c of res.cases) lines.push(`[${c.status}] ${c.id} exit=${c.exitCode} signal=${c.signal} ${c.elapsedMs}ms\n${c.stdout}${c.stderr ? `\nstderr: ${c.stderr}` : ''}`);
  lines.push(`cleanup: ${res.cleanup ? (res.cleanup.confirmed ? 'confirmed' : 'UNCONFIRMED') : 'n/a'}; limits: ${JSON.stringify(res.effectiveLimits)}`);
  $('results').textContent = lines.join('\n\n');
}

$('importFile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  if (f.size > 5 * 1024 * 1024) { banner('Import rejected: file larger than 5 MiB'); ev.target.value = ''; return; }
  const text = await f.text();
  let r = await api.packs.import({ jsonText: text, replace: false });
  if (!r.ok && r.error.code === 'CONFLICT' && window.confirm(`${r.error.message}\nReplace existing pack?`)) r = await api.packs.import({ jsonText: text, replace: true });
  banner(r.ok ? '' : `Import failed: ${errText(r.error)}`);
  if (r.ok) $('backend').title = `imported ${r.value.packId}`;
  ev.target.value = '';
  await loadCatalog();
});
$('reload').addEventListener('click', async () => {
  const r = await api.packs.reload();
  banner(r.ok ? '' : `Reload failed, previous catalog retained: ${errText(r.error)}`);
  await loadCatalog();
  if (r.ok && S.key) { const still = S.catalog.problems.find((p) => p.key === S.key); if (still) await openProblem(S.key); }
});
$('retry').addEventListener('click', async () => { $('backend').textContent = 'backend: checking'; await api.backend.retry(); refreshBackend(); });
$('search').addEventListener('input', renderList);
$('lang').addEventListener('change', async () => { await flushSave(); S.lang = $('lang').value; await loadDraft(); });
$('editor').addEventListener('input', () => { S.dirty = true; $('saveState').textContent = 'unsaved'; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(flushSave, 800); });
$('save').addEventListener('click', async () => { S.dirty = true; await flushSave(); });
$('runEx').addEventListener('click', () => execute('examples'));
$('runCustom').addEventListener('click', () => execute('custom'));
$('submit').addEventListener('click', () => execute('submit'));
$('cancel').addEventListener('click', async () => { if (S.curJob) await api.execution.cancel({ jobId: S.curJob }); });
window.addEventListener('beforeunload', () => { flushSave(); });

loadCatalog().then(refreshBackend);
setInterval(refreshBackend, 1500);
