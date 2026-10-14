'use strict';
// Optional preload contract only. No transport, source execution, or result storage here.
(() => {
  const get = id => document.getElementById(id);
  const editor = get('draft');
  const run = get('run-draft');
  const result = get('run-result');
  const note = get('execution-note');
  const offlineNote = note.textContent;
  let bridge;
  let enabled = false;
  let pending = false;
  let revision = 0;

  function show(text, state) {
    result.textContent = text;
    result.dataset.state = state;
  }
  // Mirrors the producer contract in desktop/judge-bridge.cjs and BRIDGE.md.
  function validResponse(r) {
    if (r === null || typeof r !== 'object' || Array.isArray(r) ||
        Object.keys(r).sort().join(',') !== 'elapsed_s,reason,status,verdict') return false;
    if (r.status === 'JUDGED') {
      return ['ACCEPTED', 'WRONG_ANSWER', 'RUNTIME_ERROR'].includes(r.verdict) && r.reason === null &&
        typeof r.elapsed_s === 'number' && Number.isFinite(r.elapsed_s) && r.elapsed_s >= 0 && r.elapsed_s <= 28;
    }
    if (!['UNAVAILABLE', 'INVALID_INPUT'].includes(r.status) || r.verdict !== null || r.elapsed_s !== null) return false;
    return r.status === 'INVALID_INPUT' ? r.reason === 'invalid_source_or_problem' :
      typeof r.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(r.reason);
  }
  function unavailable() {
    enabled = false;
    note.textContent = offlineNote;
    get('execution-label').textContent = 'NOT CONNECTED';
  }
  function controls() {
    run.disabled = !enabled || pending;
    get('submit-draft').disabled = true;
    run.setAttribute('aria-busy', String(pending));
  }
  editor.addEventListener('input', () => {
    revision++;
    show(pending ? 'Draft changed during Run; its result will be discarded.' : '', pending ? 'pending' : 'idle');
  });
  run.addEventListener('click', async () => {
    if (!enabled || pending) return;
    const startedRevision = revision;
    const source = editor.value;
    pending = true;
    controls();
    show('Running experimental check… Result is temporary, not a submission.', 'pending');
    try {
      const response = await bridge.run({source, problemId: 'sum-array-v1'});
      // Never reflect bridge reasons or exception details; they may contain source or internals.
      if (!validResponse(response)) throw new Error('Invalid result');
      if (response.status === 'UNAVAILABLE') unavailable();
      if (revision !== startedRevision || editor.value !== source) {
        // The bridge latches after UNAVAILABLE, so never tell the user to retry.
        show(response.status === 'UNAVAILABLE'
          ? 'Run unavailable. No verdict exists for the edited draft, and Run stays disabled until the app is restarted.'
          : 'Run result discarded: draft changed. Run again to check this draft.',
        response.status === 'UNAVAILABLE' ? 'error' : 'stale');
      } else if (response.status === 'JUDGED') {
        const elapsed = ` · ${response.elapsed_s.toFixed(3)} s`;
        show(`Experimental Run: ${response.verdict}${elapsed}. Temporary result, not a submission; not saved or verifiable.`, 'judged');
      } else {
        show(response.status === 'UNAVAILABLE' ? 'Run unavailable. No verdict on this draft.' :
          'Run input invalid. Review your draft; no verdict was returned.', 'error');
      }
    } catch (_) {
      unavailable();
      show('Run failed or is unavailable. No verdict on the current draft.', 'error');
    } finally {
      pending = false;
      controls();
    }
  });
  async function capabilities() {
    try {
      bridge = window.mecodeJudge;
      if (!bridge || typeof bridge.capabilities !== 'function' || typeof bridge.run !== 'function') return;
      const capability = await bridge.capabilities();
      if (!capability || capability.enabled !== true || typeof capability.reason !== 'string') return;
      enabled = true;
      get('execution-label').textContent = 'EXPERIMENTAL';
      note.textContent = 'Experimental Run checks the current draft. Results are temporary, not saved or verifiable submissions. Submit is unavailable. Check save status above for draft storage.';
    } catch (_) {
      unavailable();
    } finally {
      controls();
    }
  }
  capabilities();
})();
