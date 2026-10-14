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
