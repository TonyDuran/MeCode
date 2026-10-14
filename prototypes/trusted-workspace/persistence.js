'use strict';
// Fixed local record only. No editor execution, paths, network or native bridge.
(() => {
  const KEY = 'sum-array-v1', LIMIT = 1024 * 1024;
  const editor = document.getElementById('draft');
  const themeButton = document.getElementById('theme');
  const status = document.getElementById('save-status');
  const retry = document.getElementById('retry-save');
  const recover = document.getElementById('recover-prior');
  const notice = document.getElementById('storage-notice');
  const encoder = new TextEncoder();
  let db, baseline, current = null, prior = null, revision = 0;
  let generation = 0, acknowledged = -1, unsaved = false, blocked = false, queue = Promise.resolve(), timer;
  let damaged = null, priorCandidate = null, applying = false;

  function show(text, kind = 'pending') {
    status.textContent = text;
    status.dataset.state = kind;
  }
  function sameKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  }
  async function digest(snapshot) {
    const data = JSON.stringify([snapshot.schemaVersion, snapshot.problemId, snapshot.draft, snapshot.theme, snapshot.revision]);
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(data))), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function valid(snapshot) {
    if (!sameKeys(snapshot, ['schemaVersion', 'problemId', 'draft', 'theme', 'revision', 'sha256'])) return false;
    return snapshot.schemaVersion === 1 && snapshot.problemId === KEY &&
      typeof snapshot.draft === 'string' && encoder.encode(snapshot.draft).length <= LIMIT &&
      ['dark', 'light'].includes(snapshot.theme) && Number.isSafeInteger(snapshot.revision) &&
      snapshot.revision > 0 && snapshot.revision < Number.MAX_SAFE_INTEGER &&
      typeof snapshot.sha256 === 'string' && snapshot.sha256 === await digest(snapshot);
  }
  function read() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readonly');
      const request = tx.objectStore('workspace').get(KEY);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error('Read aborted'));
      tx.onerror = () => {}; // Abort handler owns visible error; never acknowledges.
    });
  }
  function replace(record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite');
      const store = tx.objectStore('workspace');
      const request = store.get(KEY);
      let conflict = false;
      request.onsuccess = () => {
        if (JSON.stringify(request.result) !== JSON.stringify(baseline)) {
          conflict = true;
          tx.abort();
          return;
        }
        try {
          store.put(record, KEY);
        } catch (error) {
          tx.abort();
        }
      };
      tx.oncomplete = () => { baseline = record; resolve(); };
      tx.onabort = () => reject(new Error(conflict ? 'Stored state changed elsewhere; close and reopen before saving.' : 'Local write failed or aborted.'));
      tx.onerror = () => {};
    });
  }
  function apply(snapshot) {
    editor.value = snapshot.draft;
    document.documentElement.dataset.theme = snapshot.theme;
    const light = snapshot.theme === 'light';
    themeButton.textContent = light ? 'Dark theme ◐' : 'Light theme ◐';
    themeButton.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    // Existing UI input handling updates line numbers, not persistence while loading.
    applying = true;
    editor.dispatchEvent(new Event('input'));
    applying = false;
  }
  async function snapshot(draft, theme, nextRevision) {
    if (!Number.isSafeInteger(nextRevision) || nextRevision >= Number.MAX_SAFE_INTEGER) throw new Error('Revision limit reached; saving blocked.');
    const value = {schemaVersion: 1, problemId: KEY, draft, theme, revision: nextRevision};
    value.sha256 = await digest(value);
    return value;
  }
  function schedule() {
    if (applying) return;
    unsaved = true;
    if (!db || blocked) return;
    generation++;
    show('Unsaved changes');
    retry.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(enqueue, 200);
  }
  function enqueue() {
    clearTimeout(timer);
    const token = generation, text = editor.value, theme = document.documentElement.dataset.theme;
    if (encoder.encode(text).length > LIMIT) {
      show('Not saved · draft exceeds 1 MiB UTF-8; shorten it to save.', 'error');
      retry.hidden = true;
      return;
    }
    queue = queue.then(async () => {
      if (blocked || token !== generation) return;
      show('Saving locally…');
      try {
        const next = await snapshot(text, theme, revision + 1);
        const record = {schemaVersion: 1, current: next, previous: current, quarantine: baseline?.quarantine || null};
        await replace(record); // Only transaction completion counts as saved.
        prior = current;
        current = next;
        revision = next.revision;
        if (token === generation) {
          acknowledged = token;
          unsaved = false;
          show('Saved locally · unjudged', 'saved');
          retry.hidden = true;
        }
      } catch (error) {
        if (token === generation) {
          show(`Not saved · ${error.message} Your text is still here.`, 'error');
          retry.hidden = false;
        }
      }
    });
  }
  retry.addEventListener('click', () => { if (!blocked) enqueue(); });
  recover.addEventListener('click', async () => {
    if (recover.disabled || !priorCandidate || !damaged || baseline?.quarantine) return;
    // Exclude user input synchronously, before hashing or transaction completion.
    recover.disabled = true;
    editor.disabled = true;
    show('Recovering prior snapshot… editing temporarily disabled.');
    notice.textContent = 'Recovery replaces the current-session text with the prior snapshot. Only the damaged saved pair is archived, not current-session edits.';
    try {
      const next = await snapshot(priorCandidate.draft, priorCandidate.theme, priorCandidate.revision + 1);
      // Preserve the damaged pair in the same fixed-key record, one bounded archive.
      const record = {schemaVersion: 1, current: next, previous: priorCandidate, quarantine: damaged};
      if (encoder.encode(JSON.stringify(record)).length > 4 * LIMIT) throw new Error('Corrupt state too large to preserve safely; recovery blocked.');
      await replace(record);
      current = next; prior = priorCandidate; revision = next.revision;
      apply(next);
      blocked = false; editor.disabled = false; themeButton.disabled = false;
      acknowledged = generation;
      unsaved = false;
      show('Saved locally · prior snapshot recovered', 'saved');
      notice.textContent = 'Prior snapshot explicitly recovered; current-session text replaced. Only damaged saved snapshots are archived locally, not current-session edits; not crash-proof storage.';
      recover.hidden = true;
    } catch (error) {
      show(`Recovery not saved · ${error.message} Current-session text retained; automatic saving still blocked.`, 'error');
      notice.textContent = 'Recovery failed. The damaged saved pair is unchanged and current-session text remains unsaved. Recover replaces this text; only the damaged saved pair will be archived.';
      recover.disabled = false;
    } finally {
      editor.disabled = false;
    }
  });
  editor.addEventListener('input', schedule);
  themeButton.addEventListener('click', schedule);
  window.addEventListener('beforeunload', event => {
    if (unsaved) {
      event.preventDefault(); event.returnValue = '';
    }
  });
  async function start() {
    editor.disabled = true; themeButton.disabled = true;
    show('Opening local workspace…');
    try {
      db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('mecode-poc-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('workspace');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Storage unavailable'));
        request.onblocked = () => reject(new Error('Storage upgrade blocked; close other windows.'));
      });
      db.onversionchange = () => {
        db.close(); blocked = true;
        show('Storage changed elsewhere. Unsaved text retained; reopen before saving.', 'error');
      };
      baseline = await read();
      if (baseline === undefined) {
        show('Not saved yet · edit to save locally');
      } else {
        const envelope = sameKeys(baseline, ['schemaVersion', 'current', 'previous', 'quarantine']) && baseline.schemaVersion === 1;
        const goodCurrent = await valid(baseline?.current);
        const goodPrior = baseline?.previous === null || await valid(baseline?.previous);
        const quarantineOK = baseline?.quarantine === null || sameKeys(baseline?.quarantine, ['current', 'previous']);
        const ordered = baseline?.previous === null || (goodCurrent && goodPrior && baseline.previous.revision < baseline.current.revision);
        if (!envelope || !goodCurrent || !goodPrior || !ordered || !quarantineOK) {
          if (goodCurrent) apply(baseline.current);
          blocked = true;
          show('Corrupt saved state · automatic saving blocked.', 'error');
          notice.textContent = goodCurrent ? 'Valid current draft shown; another part of the record is corrupt. Stored data is preserved and automatic saving is blocked.' : 'Stored data is preserved; the displayed starter is not a reset of saved data. Automatic saving is blocked.';
          damaged = {current: baseline?.current ?? null, previous: baseline?.previous ?? null};
          if (envelope && await valid(baseline.previous) && baseline.quarantine === null) {
            priorCandidate = baseline.previous;
            notice.textContent += ' Recovery explicitly replaces current-session text with the valid prior snapshot. Only the damaged saved pair is archived, not current-session edits.';
            recover.hidden = false;
          } else {
            notice.textContent += ' No recoverable prior snapshot (or an archive already exists); reset only after reviewing/backing up the profile.';
          }
          // Keep current-session text editable, but never overwrite damaged storage.
          editor.disabled = false;
          return;
        }
        current = baseline.current; prior = baseline.previous; revision = current.revision;
        apply(current);
        acknowledged = generation;
        show('Saved locally · restored / unjudged', 'saved');
        if (baseline.quarantine) notice.textContent = 'Recovered workspace; damaged snapshots remain archived locally.';
      }
      editor.disabled = false; themeButton.disabled = false;
    } catch (error) {
      blocked = true;
      editor.disabled = false; themeButton.disabled = false;
      show(`Local storage unavailable · ${error.message}. Text remains unsaved.`, 'error');
      notice.textContent = 'Do not close unsaved text. No weaker security or alternative origin is used.';
    }
  }
  start();
})();
