// Runtime app files only. Judge Python is a separate allowlisted extraResource.
const WORKSPACE_ASSETS = Object.freeze(['index.html', 'styles.css', 'app-styles.css', 'app.js',
  'run-ui.js', 'persistence.js', 'evidence.js', 'evidence-contract.js']);
const APP_ASSETS = new Set(['package.json', 'main.cjs', 'security.cjs', 'preload.cjs',
  'judge-bridge.cjs', 'judge-assets.cjs', 'modal.cjs', 'prompt.html', 'prompt-preload.cjs', 'workspace', ...WORKSPACE_ASSETS.map(name => `workspace/${name}`)]);

function ignoreAppPath(file) {
  const relative = file.replaceAll('\\', '/').replace(/^\//, '');
  return relative !== '' && !APP_ASSETS.has(relative);
}

module.exports = { WORKSPACE_ASSETS, ignoreAppPath };
