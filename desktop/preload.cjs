// Sandboxed preload: deliberately no generic invoke, events, Node or paths.
const { contextBridge, ipcRenderer } = require('electron');
const invalid = () => ({ status: 'INVALID_INPUT', verdict: null,
  reason: 'invalid_source_or_problem', elapsed_s: null });

contextBridge.exposeInMainWorld('mecodeJudge', Object.freeze({
  capabilities: async () => {
    try { return await ipcRenderer.invoke('mecode:judge:capabilities'); }
    catch { return { enabled: false, reason: 'bridge_transport_failed' }; }
  },
  run: async request => {
    let payload;
    try {
      if (request === null || typeof request !== 'object' || Array.isArray(request)
          || Object.keys(request).sort().join(',') !== 'problemId,source') return invalid();
      // Snapshot once inside the exception boundary, including accessors/proxies.
      const {source, problemId} = request;
      if (problemId !== 'sum-array-v1' || typeof source !== 'string' || source.length > 16384) return invalid();
      const bytes = new TextEncoder().encode(source);
      if (bytes.length > 16384 || new TextDecoder('utf-8', {ignoreBOM: true}).decode(bytes) !== source) return invalid();
      payload = {source, problemId};
    } catch { return invalid(); }
    try { return await ipcRenderer.invoke('mecode:judge:run', payload); }
    catch { return { status: 'UNAVAILABLE', verdict: null, reason: 'bridge_transport_failed', elapsed_s: null }; }
  },
}));

// Ordinary link trigger prevention (click, auxclick, Enter on a focused link). This is
// defense against accidental workspace loss, NOT confinement: scripts and other document
// replacement paths are out of scope. Only same-document hash links are allowed.
(function guardLinks() {
  function linkTarget(event) {
    let nodes = [];
    try { nodes = typeof event.composedPath === 'function' ? event.composedPath() : []; } catch { nodes = []; }
    for (const node of nodes) {
      if (!node || (node.localName !== 'a' && node.localName !== 'area')) continue;
      const raw = node.getAttribute('href') ?? node.getAttribute('xlink:href');
      if (raw !== null && raw !== undefined) return String(raw);
    }
    return null;
  }
  function allowed(raw) {
    try {
      const target = new URL(raw, document.baseURI);
      const here = new URL(window.location.href);
      target.hash = ''; here.hash = '';
      return target.href === here.href && raw.includes('#');
    } catch { return false; }
  }
  let notice = null;
  function tell() {
    try {
      if (notice || !document.body) return;
      notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.textContent = 'Link blocked: MeCode stays in the workspace. If the window ever stops showing it, '
        + 'choose File > Restore saved workspace (Ctrl+Shift+R) to reload your last saved draft.';
      Object.assign(notice.style, { position: 'fixed', left: '12px', bottom: '12px', maxWidth: '36em',
        padding: '8px 12px', background: '#222', color: '#fff', border: '1px solid #888',
        font: '14px sans-serif', zIndex: '2147483647' });
      document.body.appendChild(notice);
      setTimeout(() => { try { notice.remove(); } catch { /* gone */ } notice = null; }, 8000);
    } catch { /* notice is best effort */ }
  }
  function guard(event) {
    const raw = linkTarget(event);
    if (raw === null || allowed(raw)) return;
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    tell();
  }
  window.addEventListener('click', guard, true);
  window.addEventListener('auxclick', guard, true);
  window.addEventListener('keydown', event => { if (event.key === 'Enter') guard(event); }, true);
})();
