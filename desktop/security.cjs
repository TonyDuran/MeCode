const { pathToFileURL } = require('node:url');

function browserPreferences() {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  };
}

function allowsNavigation(target, indexPath) {
  try {
    const actual = new URL(target);
    actual.hash = '';
    return actual.href === pathToFileURL(indexPath).href;
  } catch {
    return false;
  }
}

module.exports = { browserPreferences, allowsNavigation };
