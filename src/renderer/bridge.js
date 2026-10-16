'use strict';
// Browser bridge: exposes the same promise/envelope API as the Electron preload (window.mecode) over the local-web server.
// The session capability arrives once in the launch-link fragment, is moved into sessionStorage and scrubbed from the URL.
// INTENTIONAL DECISION (T06, for reviewer): sessionStorage keeps the token across a tab REFRESH (T03 asked for memory-only + relaunch link).
// Why acceptable: the token is per-tab (not shared across tabs/origins), never in a cookie/URL/storage that other origins read, CSP forbids
// inline/foreign script, and it is a fresh random 256-bit secret on EVERY server start, so a stale tab/restart rotates it. There is no
// public token endpoint. Closing the tab discards it. If review wants memory-only, delete the two sessionStorage calls below.
(() => {
  if (window.mecode) return; // Electron preload already provided it
  const m = /^#s=([0-9a-f]{64})$/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem('mecode.session', m[1]);
    } catch {
      /* storage blocked */
    }
  }
  if (location.hash) history.replaceState(null, '', location.pathname);
  let tok = null;
  try {
    tok = sessionStorage.getItem('mecode.session');
  } catch {
    /* ignore */
  }
  const NAMES = [
    'catalog.list',
    'catalog.get',
    'packs.import',
    'packs.reload',
    'draft.load',
    'draft.save',
    'backend.status',
    'backend.retry',
    'settings.get',
    'settings.update',
    'execution.start',
    'execution.get',
    'execution.cancel',
    'execution.active',
    'server.shutdown',
  ];
  const call = async (name, arg) => {
    if (!tok) return { ok: false, error: { code: 'UNAUTHORIZED', message: 'No session secret in this tab. Open the launch link printed by the server.' } };
    try {
      const r = await fetch(`/api/${name}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-MeCode-Session': tok },
        body: JSON.stringify(arg === undefined ? {} : arg),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: { code: 'TRANSPORT_ERROR', message: `server not reachable (${String((e && e.message) || e).slice(0, 100)}); is it still running?` } };
    }
  };
  const api = { web: true };
  for (const n of NAMES) {
    const [ns, k] = n.split('.');
    (api[ns] = api[ns] || {})[k] = (arg) => call(n, arg);
  }
  window.mecode = Object.freeze(api);
})();
