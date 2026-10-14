const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { browserPreferences, allowsNavigation } = require('../security.cjs');

test('renderer has no Node or preload authority and stays sandboxed', () => {
  const prefs = browserPreferences();
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.webviewTag, false);
  assert.equal(Object.hasOwn(prefs, 'preload'), false);
});

test('navigation permits only the bundled workspace document', () => {
  const file = path.resolve(__dirname, '..', 'workspace', 'index.html');
  const expected = pathToFileURL(file).href;
  assert.equal(allowsNavigation(expected, file), true);
  assert.equal(allowsNavigation(`${expected}#draft`, file), true);
  for (const url of ['https://example.org/', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)',
                     pathToFileURL(path.join(path.dirname(file), 'app.js')).href]) {
    assert.equal(allowsNavigation(url, file), false, url);
  }
});
