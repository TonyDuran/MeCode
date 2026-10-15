'use strict';
// Renderer: no node, text-only rendering (textContent), all host access via window.mecode (Electron preload OR web bridge).
const $ = (id) => document.getElementById(id);
const api = window.mecode;
const LANGS = { python: 'Python 3', javascript: 'JavaScript', cpp: 'C++17', c: 'C17' };
// gen: bumped on every editor-context change; async completions compare against it (P1-7)
const S = { catalog: null, key: null, prob: null, lang: 'python', gen: 0, dirty: false, saving: null, saveTimer: null, job: null, starting: false, backend: null, loadFailed: false, revs: new Map(), settingsLoaded: false };

function banner(msg) { const b = $('banner'); b.hidden = !msg; b.textContent = msg || ''; }
function errText(e) {
  if (!e) return 'unknown error';
  let s = `${e.code || 'ERROR'}: ${e.message || ''}`;
  if (Array.isArray(e.details)) s += '\n' + e.details.slice(0, 10).map((d) => `  ${d && d.file || ''} ${d && d.path || ''}: ${d && d.message || ''}`).join('\n');
  else if (e.details && typeof e.details === 'object') { try { s += ` ${JSON.stringify(e.details).slice(0, 200)}`; } catch { /* ignore */ } }
  return s;
}
const revFor = (k, l) => S.revs.get(`${k}|${l}`) || 0;

async function refreshBackend() {
  const r = await api.backend.status();
  if (!r.ok) { $('backend').textContent = `backend: unknown — ${errText(r.error)}`; return; }
  S.backend = r.value; const v = r.value;
  $('backend').textContent = `backend: ${v.state}` + (v.reason ? ` — ${v.reason}` : '') + (v.state === 'ready' ? ` (${v.languages.map((l) => `${l.id} ${l.version}`).join(', ')})` : '');
  $('retry').hidden = v.state !== 'unavailable';
  const canRun = v.state === 'ready' && !S.job && !S.starting && S.prob && !S.loadFailed;
  for (const id of ['runEx', 'runCustom', 'submit']) $(id).disabled = !canRun;
  $('cancel').disabled = !S.job;
}

function renderList() {
  const q = $('search').value.toLowerCase();
  const ul = $('list'); ul.replaceChildren();
  for (const p of S.catalog.problems) {
    if (q && !(p.title.toLowerCase().includes(q) || p.patterns.join(' ').includes(q))) continue;
    const li = document.createElement('li');
    li.textContent = `[${p.status}] ${p.title} · ${p.difficulty} · ${p.patterns.join(', ')}`;
    li.dataset.key = p.key;
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
  banner(msgs.join('\n'));
  $('packsDir').textContent = `managed packs folder: ${r.value.packsDir}`;
  renderList();
}

/** Explicit success/failure. On failure the draft stays dirty and visible; nothing navigates away. */
function flushSave() {
  clearTimeout(S.saveTimer);
  const run = async () => {
    if (!S.prob || !S.dirty || S.loadFailed) return true;
    const key = S.key, lang = S.lang, gen = S.gen, source = $('editor').value;
    $('saveState').textContent = 'saving…';
    const r = await api.draft.save({ key, language: lang, source, baseRevision: revFor(key, lang) });
    if (r.ok) {
      S.revs.set(`${key}|${lang}`, r.value.revision);
      if (S.gen === gen && $('editor').value === source) { S.dirty = false; $('saveState').textContent = `saved (rev ${r.value.revision})`; return true; }
      if (S.gen === gen) return run(); // typed more while saving
      return true;
    }
    S.dirty = true;
    $('saveState').textContent = `SAVE FAILED (draft kept in editor): ${errText(r.error)}`;
    return false;
  };
  S.saving = (S.saving || Promise.resolve(true)).then(run, run); // serialized; a failed save never poisons the chain
  return S.saving;
}

async function openProblem(key) {
  if (!(await flushSave())) return;
  const gen = ++S.gen;
  const r = await api.catalog.get({ key });
  if (gen !== S.gen) return; // a newer navigation won
  if (!r.ok) { banner(errText(r.error)); return; }
  S.key = key; S.prob = r.value; S.loadFailed = false;
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
  await loadDraft(gen);
  if (gen !== S.gen) return;
  paintStoredResult();
  renderList(); refreshBackend();
}

async function loadDraft(gen) {
  const key = S.key, lang = S.lang;
  const d = await api.draft.load({ key, language: lang });
  if (gen !== S.gen) return;
  if (!d.ok) { // never replace an unreadable draft with a writable starter
    S.loadFailed = true; $('editor').value = ''; $('editor').disabled = true;
    $('saveState').textContent = `DRAFT LOAD FAILED (editing disabled so nothing is overwritten): ${errText(d.error)}`;
    return;
  }
  $('editor').disabled = false; S.loadFailed = false;
  S.revs.set(`${key}|${lang}`, d.value.revision);
  $('editor').value = d.value.source !== null ? d.value.source : (S.prob.starters[lang] || '');
  $('saveState').textContent = d.value.source !== null ? `draft restored (rev ${d.value.revision})` : 'starter template (unsaved)';
  S.dirty = false;
}

// ---- execution: one global active job, independent of which problem is displayed
const results = new Map(); // `${key}|${lang}|${hash}` -> last result
function paintStoredResult() {
  const r = S.prob && results.get(`${S.key}|${S.lang}|${S.prob.contentHash}`);
  if (r) show(r); else { $('verdict').textContent = 'No result yet'; $('verdict').className = ''; $('results').textContent = ''; }
}
function sameContext(j) { return S.prob && j.key === S.key && j.language === S.lang && j.contentHash === S.prob.contentHash; }

async function execute(mode) {
  if (S.starting || S.job) return; // single flight
  S.starting = true; refreshBackend();
  try {
    if (!(await flushSave())) { $('verdict').textContent = 'Not run: the draft could not be saved (see Save status).'; $('verdict').className = 'INFRA_ERROR'; return; }
    const job = { key: S.key, language: S.lang, contentHash: S.prob.contentHash, mode };
    const r = await api.execution.start({ key: job.key, contentHash: job.contentHash, language: job.language, source: $('editor').value, mode, customInput: $('custom').value });
    if (!r.ok) { $('verdict').textContent = `Could not start: ${errText(r.error)}`; $('verdict').className = 'INFRA_ERROR'; return; }
    job.jobId = r.value.jobId; S.job = job;
    $('verdict').textContent = 'Running…'; $('verdict').className = ''; $('results').textContent = '';
  } finally { S.starting = false; }
  pollJob(S.job);
  refreshBackend();
}

async function pollJob(job) {
  for (;;) {
    await new Promise((res) => setTimeout(res, 250));
    if (S.job !== job) return;
    const g = await api.execution.get({ jobId: job.jobId });
    if (S.job !== job) return;
    if (!g.ok) { if (g.error.code === 'TRANSPORT_ERROR') { $('bgjob').textContent = errText(g.error); continue; } S.job = null; $('verdict').textContent = errText(g.error); refreshBackend(); return; }
    if (g.value.state === 'done') {
      S.job = null; const res = g.value.result;
      results.set(`${job.key}|${job.language}|${job.contentHash}`, res);
      if (sameContext(job)) show(res); else $('bgjob').textContent = `Background job for ${job.key} (${job.language}) finished: ${res.verdict}`;
      await loadCatalog(); refreshBackend(); return;
    }
    if (g.value.phase === 'persisting' && sameContext(job)) $('verdict').textContent = 'Saving result…';
  }
}

function show(res) {
  let head = `${res.mode}: ${res.verdict}` + (res.message ? ` — ${res.message}` : '');
  if (res.persistence === 'failed') head += `  [WARNING: execution result is real but progress was NOT saved (${res.persistError || 'write failed'})]`;
  $('verdict').textContent = head;
  $('verdict').className = res.verdict;
  const lines = [];
  if (res.compile) lines.push(`compile: ${res.compile.ok ? 'ok' : 'FAILED'}${res.compile.timedOut ? ' (timed out)' : ''}\n${res.compile.output}`);
  for (const c of res.cases) lines.push(`[${c.status}] ${c.id} exit=${c.exitCode} signal=${c.signal} ${c.elapsedMs}ms\n${c.stdout}${c.stderr ? `\nstderr: ${c.stderr}` : ''}`);
  lines.push(`cleanup: ${res.cleanup ? (res.cleanup.confirmed ? 'confirmed' : 'UNCONFIRMED') : 'n/a'}; persistence: ${res.persistence || 'n/a'}; limits: ${JSON.stringify(res.effectiveLimits)}`);
  $('results').textContent = lines.join('\n\n');
}

// ---- pack import / reload (failures keep the last-good catalog server-side)
$('importFile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  if (f.size > 5 * 1024 * 1024) { banner('Import rejected: file larger than 5 MiB'); ev.target.value = ''; return; }
  const text = await f.text();
  let r = await api.packs.import({ jsonText: text, replace: false });
  if (!r.ok && r.error.code === 'CONFLICT' && window.confirm(`${r.error.message}\nReplace existing pack?`)) r = await api.packs.import({ jsonText: text, replace: true });
  ev.target.value = '';
  await loadCatalog();
  const extra = r.ok ? (r.value.warning || '') : `Import failed (catalog unchanged): ${errText(r.error)}`;
  if (extra) banner(`${extra}${$('banner').textContent ? `\n${$('banner').textContent}` : ''}`);
  $('importStatus').textContent = r.ok ? `imported pack ${r.value.packId} (${r.value.problemCount} problems)` : 'import failed';
});
$('reload').addEventListener('click', async () => {
  if (!(await flushSave())) return;
  const r = await api.packs.reload();
  await loadCatalog();
  if (!r.ok) banner(`Reload failed, previous catalog retained: ${errText(r.error)}${$('banner').textContent ? `\n${$('banner').textContent}` : ''}`);
  $('importStatus').textContent = r.ok ? `reloaded (${r.value.problemCount} problems)` : 'reload failed';
  if (r.ok && S.key) { const still = S.catalog.problems.find((p) => p.key === S.key); if (still) await openProblem(S.key); }
});
$('retry').addEventListener('click', async () => { $('backend').textContent = 'backend: checking'; await api.backend.retry(); refreshBackend(); });
$('search').addEventListener('input', () => { if (S.catalog) renderList(); });
$('lang').addEventListener('change', async () => {
  const want = $('lang').value;
  if (!(await flushSave())) { $('lang').value = S.lang; return; } // keep the dirty draft; do not switch
  const gen = ++S.gen; S.lang = want; await loadDraft(gen); if (gen === S.gen) { paintStoredResult(); refreshBackend(); }
});
$('editor').addEventListener('input', () => { S.dirty = true; $('saveState').textContent = 'unsaved'; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(flushSave, 800); });
$('save').addEventListener('click', async () => { if (S.prob && !S.loadFailed) S.dirty = true; await flushSave(); });
$('runEx').addEventListener('click', () => execute('examples'));
$('runCustom').addEventListener('click', () => execute('custom'));
$('submit').addEventListener('click', () => execute('submit'));
$('cancel').addEventListener('click', async () => { if (S.job) { const r = await api.execution.cancel({ jobId: S.job.jobId }); if (!r.ok) $('bgjob').textContent = errText(r.error); } });
window.addEventListener('beforeunload', (ev) => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } flushSave(); });

// ---- settings (execution limits)
$('settingsOpen').addEventListener('toggle', async () => {
  if (!$('settingsOpen').open || S.settingsLoaded) return;
  const r = await api.settings.get(); if (!r.ok) { $('settingsMsg').textContent = errText(r.error); return; }
  const box = $('settingsFields'); box.replaceChildren();
  for (const [k, [lo, hi]] of Object.entries(r.value.ranges)) {
    const l = document.createElement('label'); l.textContent = `${k} (${lo}..${hi}) `;
    const i = document.createElement('input'); i.type = 'number'; i.id = `lim-${k}`; i.value = r.value.limits[k]; i.step = k === 'cpus' ? '0.25' : '1'; l.append(i); box.append(l);
  }
  S.settingsLoaded = true;
});
$('settingsApply').addEventListener('click', async () => {
  const limits = {};
  for (const i of $('settingsFields').querySelectorAll('input')) limits[i.id.slice(4)] = Number(i.value);
  const r = await api.settings.update({ limits });
  $('settingsMsg').textContent = r.ok ? 'limits saved; applied to the next engine container' : `not applied: ${errText(r.error)}`;
  refreshBackend();
});

if (api.server) {
  $('quit').hidden = false;
  $('quit').addEventListener('click', async () => {
    if ((S.dirty || S.job) && !window.confirm('Unsaved draft or a running job. Stop the server anyway?')) return;
    const r = await api.server.shutdown();
    document.body.textContent = r.ok ? 'MeCode server stopped. You can close this tab.' : `Shutdown failed: ${errText(r.error)}`;
  });
}

(async () => {
  await loadCatalog(); await refreshBackend();
  const a = await api.execution.active();
  if (a.ok && a.value.active) { S.job = a.value.active; $('bgjob').textContent = `Resuming running job on ${S.job.key} (${S.job.language})`; pollJob(S.job); }
})();
setInterval(refreshBackend, 1500);
