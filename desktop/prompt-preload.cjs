// Sandboxed preload for the fixed prompt page ONLY. Exposes nothing to the page: it renders
// main-supplied text with textContent and sends one integer choice back, once.
const { ipcRenderer } = require('electron');

let sent = false;
function choose(value) {
  if (sent) return;
  sent = true;
  try { ipcRenderer.send('mecode:prompt:choice', value); } catch { /* main treats no answer as Keep */ }
}

ipcRenderer.once('mecode:prompt:init', (_event, spec) => {
  try {
    if (!spec || typeof spec.message !== 'string' || typeof spec.detail !== 'string'
        || !Array.isArray(spec.buttons) || spec.buttons.length < 1 || spec.buttons.length > 2
        || !spec.buttons.every(label => typeof label === 'string')) return;
    document.getElementById('message').textContent = spec.message;
    document.getElementById('detail').textContent = spec.detail;
    const holder = document.getElementById('buttons');
    let focus = null;
    spec.buttons.forEach((label, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', event => { if (event.isTrusted) choose(i); });
      holder.appendChild(button);
      if (i === spec.defaultId) focus = button;
    });
    if (focus) focus.focus();
    document.addEventListener('keydown', event => {
      if (event.isTrusted && event.key === 'Escape') choose(Number.isInteger(spec.cancelId) ? spec.cancelId : 0);
    }, true);
  } catch { /* leave the page blank; closing it is Keep */ }
});
