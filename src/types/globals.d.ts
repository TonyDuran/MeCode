// Ambient types for the browser bridge (window.mecode, provided by the Electron preload or src/renderer/bridge.js).
interface Window {
  mecode: Record<string, any>;
}
