'use strict';
// Renderer: no node, text-only rendering (textContent), all host access via window.mecode (Electron preload OR web bridge).
/** @typedef {HTMLElement & {value: string, disabled: boolean, files: FileList, open: boolean}} AnyEl */
/** @param {string} id @returns {AnyEl} */
const $ = (id) => /** @type {AnyEl} */ (document.getElementById(id));
const api = window.mecode;
const LANGS = { python: 'Python 3', javascript: 'JavaScript', cpp: 'C++17', c: 'C17' };
// gen: bumped on every editor-context change; async completions compare against it (P1-7)
const S = {
  catalog: null,
  key: null,
  prob: null,
  lang: 'python',
  gen: 0,
  trans: false,
  dirty: false,
  saving: null,
  saveTimer: null,
  job: null,
  starting: false,
  backend: null,
  loadFailed: false,
  revs: new Map(),
  settingsLoaded: false,
};

/** R2: single place that decides what the user may do. During a context transition (navigation / language change) or a start request
 *  the editor, language, Save and Run are NOT usable, so a buffer can never be edited, saved or run under the wrong key/language. */
function canRunNow() {
  return !!(S.backend && S.backend.state === 'ready' && !S.job && !S.starting && !S.trans && S.prob && !S.loadFailed);
}
function syncControls() {
  $('editor').disabled = !!(S.trans || S.starting || S.loadFailed);
  $('lang').disabled = !!S.trans;
  $('save').disabled = !!(S.trans || S.loadFailed || !S.prob);
  const can = canRunNow();
  for (const id of ['runEx', 'runCustom', 'submit']) $(id).disabled = !can;
  $('cancel').disabled = !S.job;
}

function banner(msg) {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg || '';
}
function errText(e) {
  if (!e) return 'unknown error';
  let s = `${e.code || 'ERROR'}: ${e.message || ''}`;
  if (Array.isArray(e.details))
    s +=
      '\n' +
      e.details
        .slice(0, 10)
        .map((d) => `  ${(d && d.file) || ''} ${(d && d.path) || ''}: ${(d && d.message) || ''}`)
        .join('\n');
  else if (e.details && typeof e.details === 'object') {
    try {
      s += ` ${JSON.stringify(e.details).slice(0, 200)}`;
    } catch {
      /* ignore */
    }
  }
  return s;
}
const revFor = (k, l) => S.revs.get(`${k}|${l}`) || 0;

async function refreshBackend() {
  const r = await api.backend.status();
  if (!r.ok) {
    $('backend').textContent = `backend: unknown — ${errText(r.error)}`;
    return;
  }
  S.backend = r.value;
  const v = r.value;
  $('backend').textContent = `backend: ${v.state}` + (v.reason ? ` — ${v.reason}` : '') + (v.state === 'ready' ? ` (${v.languages.map((l) => `${l.id} ${l.version}`).join(', ')})` : '');
  $('retry').hidden = v.state !== 'unavailable';
  syncControls();
}

function renderList() {
  const q = $('search').value.toLowerCase();
  const ul = $('list');
  ul.replaceChildren();
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
  if (!r.ok) {
    banner(errText(r.error));
    return;
  }
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
    const key = S.key,
      lang = S.lang,
      source = $('editor').value;
    $('saveState').textContent = 'saving…';
    const r = await api.draft.save({ key, language: lang, source, baseRevision: revFor(key, lang) });
    const same = S.key === key && S.lang === lang; // identity of the buffer, not a navigation counter
    if (r.ok) {
      S.revs.set(`${key}|${lang}`, r.value.revision);
      if (same && $('editor').value === source) {
        S.dirty = false;
        $('saveState').textContent = `saved (rev ${r.value.revision})`;
        return true;
      }
      if (same) return run(); // typed more while saving
      return true;
    }
    S.dirty = true;
    if (same) $('saveState').textContent = `SAVE FAILED (draft kept in editor): ${errText(r.error)}`;
    return false;
  };
  S.saving = (S.saving || Promise.resolve(true)).then(run, run); // serialized; a failed save never poisons the chain
  return S.saving;
}

/** Transition lifecycle: the old context is saved FIRST, controls lock before the first await, the new context is adopted atomically. */
function beginTrans() {
  S.trans = true;
  syncControls();
}
function endTrans() {
  S.trans = false;
  syncControls();
}

function renderProblem(p) {
  $('work').hidden = false;
  $('title').textContent = p.title;
  $('meta').textContent =
    `${p.difficulty} · ${p.patterns.join(', ')} · ${p.provenance.kind} (${p.provenance.license}) · tests: ${p.examples.length} examples + ${p.checkCount} checks · hash ${p.contentHash.slice(0, 12)}`;
  $('statement').textContent = p.statement;
  $('formats').textContent = `Input:\n${p.inputFormat}\n\nOutput:\n${p.outputFormat}\n\nConstraints:\n- ${p.constraints.join('\n- ')}`;
  const ex = $('examples');
  ex.replaceChildren();
  for (const t of p.examples) {
    const pre = document.createElement('pre');
    pre.textContent = `Example ${t.id}\nstdin:\n${t.stdin}\nexpected:\n${t.expected}` + (t.explanation ? `\n${t.explanation}` : '');
    ex.append(pre);
  }
  const sel = $('lang');
  sel.replaceChildren();
  for (const l of Object.keys(LANGS)) {
    const o = document.createElement('option');
    o.value = l;
    o.textContent = LANGS[l];
    sel.append(o);
  }
}

async function openProblem(key) {
  const gen = ++S.gen; // supersedes any transition still in flight; its late responses are ignored
  beginTrans();
  try {
    if (!(await flushSave())) return; // save failed: old context stays, editable, draft kept
    if (gen !== S.gen) return;
    const r = await api.catalog.get({ key });
    if (gen !== S.gen) return;
    if (!r.ok) {
      banner(errText(r.error));
      return;
    } // old context stays usable
    const starters = Object.keys(r.value.starters);
    const lang = starters.includes(S.lang) ? S.lang : starters[0] || 'python';
    const d = await api.draft.load({ key, language: lang });
    if (gen !== S.gen) return;
    // ---- atomic adoption: key, problem, language, buffer and flags change together
    S.key = key;
    S.prob = r.value;
    S.lang = lang;
    renderProblem(r.value);
    $('lang').value = lang;
    applyDraft(key, lang, d);
    paintStoredResult();
    renderList();
  } finally {
    if (gen === S.gen) {
      $('lang').value = S.lang;
      endTrans();
      refreshBackend();
    }
  }
}

/** Never replace an unreadable draft with a writable starter. */
function applyDraft(key, lang, d) {
  if (!d.ok) {
    S.loadFailed = true;
    $('editor').value = '';
    S.dirty = false;
    $('saveState').textContent = `DRAFT LOAD FAILED (editing disabled so nothing is overwritten): ${errText(d.error)}`;
    return;
  }
  S.loadFailed = false;
  S.revs.set(`${key}|${lang}`, d.value.revision);
  $('editor').value = d.value.source !== null ? d.value.source : S.prob.starters[lang] || '';
  $('saveState').textContent = d.value.source !== null ? `draft restored (rev ${d.value.revision})` : 'starter template (unsaved)';
  S.dirty = false;
}

// ---- execution: one global active job, independent of which problem is displayed
const results = new Map(); // `${key}|${lang}|${hash}` -> last result
function paintStoredResult() {
  const r = S.prob && results.get(`${S.key}|${S.lang}|${S.prob.contentHash}`);
  if (r) show(r);
  else {
    $('verdict').textContent = 'No result yet';
    $('verdict').className = '';
    $('results').textContent = '';
  }
}
function sameContext(j) {
  return S.prob && j.key === S.key && j.language === S.lang && j.contentHash === S.prob.contentHash;
}

async function execute(mode) {
  if (S.trans || S.starting || S.job || !S.prob || S.loadFailed) return; // single flight; never from a half-switched context
  S.starting = true;
  syncControls();
  refreshBackend();
  const key = S.key,
    lang = S.lang,
    hash = S.prob.contentHash; // the editor is locked while starting, so this context + buffer cannot change under us
  const here = () => S.key === key && S.lang === lang && S.prob && S.prob.contentHash === hash;
  const say = (text, cls) => {
    if (here()) {
      $('verdict').textContent = text;
      $('verdict').className = cls || '';
    } else $('bgjob').textContent = `Run on ${key} (${lang}): ${text}`;
  };
  try {
    if (!(await flushSave())) {
      say('Not run: the draft could not be saved (see Save status).', 'INFRA_ERROR');
      return;
    }
    if (S.trans || !here()) {
      $('bgjob').textContent = `Run on ${key} (${lang}) not started: the view changed while saving.`;
      return;
    }
    const job = { key, language: lang, contentHash: hash, mode };
    const r = await api.execution.start({ key, contentHash: hash, language: lang, source: $('editor').value, mode, customInput: $('custom').value });
    if (!r.ok) {
      say(`Could not start: ${errText(r.error)}`, 'INFRA_ERROR');
      return;
    }
    job.jobId = r.value.jobId;
    S.job = job;
    if (here()) {
      $('verdict').textContent = 'Running…';
      $('verdict').className = '';
      $('results').textContent = '';
    } else $('bgjob').textContent = `Job started on ${key} (${lang}); result will be reported here.`;
  } finally {
    S.starting = false;
    syncControls();
  }
  if (S.job) pollJob(S.job);
  refreshBackend();
}

async function pollJob(job) {
  for (;;) {
    await new Promise((res) => setTimeout(res, 250));
    if (S.job !== job) return;
    const g = await api.execution.get({ jobId: job.jobId });
    if (S.job !== job) return;
    if (!g.ok) {
      if (g.error.code === 'TRANSPORT_ERROR') {
        $('bgjob').textContent = errText(g.error);
        continue;
      }
      S.job = null;
      $('verdict').textContent = errText(g.error);
      refreshBackend();
      return;
    }
    if (g.value.state === 'done') {
      S.job = null;
      const res = g.value.result;
      results.set(`${job.key}|${job.language}|${job.contentHash}`, res);
      if (sameContext(job)) show(res);
      else $('bgjob').textContent = `Background job for ${job.key} (${job.language}) finished: ${res.verdict}`;
      await loadCatalog();
      refreshBackend();
      return;
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
  if (res.compile)
    lines.push(
      `compile: ${res.compile.ok ? 'ok' : 'FAILED'}${res.compile.timedOut ? ` (timed out: ${res.compile.limit === 'job' ? 'whole-job limit' : res.compile.limit === 'compile' ? 'compile-time limit' : 'limit unknown'})` : ''}\n${res.compile.output}`,
    );
  for (const c of res.cases) lines.push(`[${c.status}] ${c.id} exit=${c.exitCode} signal=${c.signal} ${c.elapsedMs}ms\n${c.stdout}${c.stderr ? `\nstderr: ${c.stderr}` : ''}`);
  lines.push(`cleanup: ${res.cleanup ? (res.cleanup.confirmed ? 'confirmed' : 'UNCONFIRMED') : 'n/a'}; persistence: ${res.persistence || 'n/a'}; limits: ${JSON.stringify(res.effectiveLimits)}`);
  $('results').textContent = lines.join('\n\n');
}

// ---- pack import / reload (failures keep the last-good catalog server-side)
$('importFile').addEventListener('change', async (/** @type {any} */ ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) {
    banner('Import rejected: file larger than 5 MiB');
    ev.target.value = '';
    return;
  }
  const text = await f.text();
  let r = await api.packs.import({ jsonText: text, replace: false });
  if (!r.ok && r.error.code === 'CONFLICT' && window.confirm(`${r.error.message}\nReplace existing pack?`)) r = await api.packs.import({ jsonText: text, replace: true });
  ev.target.value = '';
  await loadCatalog();
  const extra = r.ok ? r.value.warning || '' : `Import failed (catalog unchanged): ${errText(r.error)}`;
  if (extra) banner(`${extra}${$('banner').textContent ? `\n${$('banner').textContent}` : ''}`);
  $('importStatus').textContent = r.ok ? `imported pack ${r.value.packId} (${r.value.problemCount} problems)` : 'import failed';
});
$('reload').addEventListener('click', async () => {
  if (!(await flushSave())) return;
  const r = await api.packs.reload();
  await loadCatalog();
  if (!r.ok) banner(`Reload failed, previous catalog retained: ${errText(r.error)}${$('banner').textContent ? `\n${$('banner').textContent}` : ''}`);
  $('importStatus').textContent = r.ok ? `reloaded (${r.value.problemCount} problems)` : 'reload failed';
  if (r.ok && S.key) {
    const still = S.catalog.problems.find((p) => p.key === S.key);
    if (still) await openProblem(S.key);
  }
});
$('retry').addEventListener('click', async () => {
  $('backend').textContent = 'backend: checking';
  await api.backend.retry();
  refreshBackend();
});
$('search').addEventListener('input', () => {
  if (S.catalog) renderList();
});
$('lang').addEventListener('change', async () => {
  if (S.trans || !S.prob) {
    $('lang').value = S.lang;
    return;
  }
  const want = $('lang').value;
  const key = S.key;
  const gen = ++S.gen;
  beginTrans();
  try {
    if (!(await flushSave())) return; // keep the dirty draft; do not switch
    if (gen !== S.gen) return;
    const d = await api.draft.load({ key, language: want });
    if (gen !== S.gen) return;
    S.lang = want;
    applyDraft(key, want, d);
    paintStoredResult(); // adopt language + buffer together
  } finally {
    if (gen === S.gen) {
      $('lang').value = S.lang;
      endTrans();
      refreshBackend();
    }
  }
});
$('editor').addEventListener('input', () => {
  if (S.trans || S.starting || S.loadFailed || !S.prob) return;
  S.dirty = true;
  $('saveState').textContent = 'unsaved';
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(flushSave, 800);
});
$('save').addEventListener('click', async () => {
  if (S.trans) return;
  if (S.prob && !S.loadFailed) S.dirty = true;
  await flushSave();
});
$('runEx').addEventListener('click', () => execute('examples'));
$('runCustom').addEventListener('click', () => execute('custom'));
$('submit').addEventListener('click', () => execute('submit'));
$('cancel').addEventListener('click', async () => {
  if (S.job) {
    $('bgjob').textContent = 'Stop requested — stopping (termination is not confirmed until the result shows cleanup: confirmed)…';
    const r = await api.execution.cancel({ jobId: S.job.jobId });
    if (!r.ok) $('bgjob').textContent = errText(r.error);
  }
});
window.addEventListener('beforeunload', (ev) => {
  if (S.dirty) {
    ev.preventDefault();
    ev.returnValue = '';
  }
  flushSave();
});

// ---- settings (execution limits)
$('settingsOpen').addEventListener('toggle', async () => {
  if (!$('settingsOpen').open || S.settingsLoaded) return;
  const r = await api.settings.get();
  if (!r.ok) {
    $('settingsMsg').textContent = errText(r.error);
    return;
  }
  const box = $('settingsFields');
  box.replaceChildren();
  for (const [k, [lo, hi]] of Object.entries(r.value.ranges)) {
    const l = document.createElement('label');
    l.textContent = `${k} (${lo}..${hi}) `;
    const i = document.createElement('input');
    i.type = 'number';
    i.id = `lim-${k}`;
    i.value = r.value.limits[k];
    i.step = k === 'cpus' ? '0.25' : '1';
    l.append(i);
    box.append(l);
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
    document.body.textContent = r.ok ? 'MeCode server is stopping (container cleanup is confirmed in the terminal that started it). You can close this tab.' : `Shutdown failed: ${errText(r.error)}`;
  });
}

(async () => {
  await loadCatalog();
  await refreshBackend();
  const a = await api.execution.active();
  if (a.ok && a.value.active) {
    S.job = a.value.active;
    $('bgjob').textContent = `Resuming running job on ${S.job.key} (${S.job.language})`;
    pollJob(S.job);
  }
})();
setInterval(refreshBackend, 1500);
