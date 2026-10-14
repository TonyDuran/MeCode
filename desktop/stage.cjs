const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCE = path.resolve(__dirname, '..', 'prototypes', 'trusted-workspace');
const ASSETS = Object.freeze(['index.html', 'styles.css', 'app-styles.css', 'app.js',
  'persistence.js', 'evidence.js', 'evidence-contract.js']);

function stageWorkspace(destination = path.join(__dirname, 'workspace'), source = SOURCE) {
  const html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
  if (!html.includes('Content-Security-Policy') || !html.includes("connect-src 'none'")) {
    throw new Error('offline workspace CSP missing');
  }
  for (const [, name] of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    if (!ASSETS.includes(name)) throw new Error(`unexpected renderer dependency: ${name}`);
  }
  const manifest = new Map();
  for (const line of fs.readFileSync(path.join(source, 'ARTIFACT-SHA256.txt'), 'utf8').trim().split('\n')) {
    const match = /^([0-9a-f]{64})  ([^\r\n]+)$/.exec(line);
    if (!match || manifest.has(match[2])) throw new Error('invalid renderer manifest');
    manifest.set(match[2], match[1]);
  }
  // Read and verify all bytes before replacing a previous staged workspace.
  const verified = ASSETS.map(name => {
    const bytes = fs.readFileSync(path.join(source, name));
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== manifest.get(name)) throw new Error(`renderer digest mismatch: ${name}`);
    return [name, bytes];
  });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of verified) fs.writeFileSync(path.join(destination, name), bytes, { mode: 0o600 });
  return destination;
}

if (require.main === module) console.log(stageWorkspace());
module.exports = { stageWorkspace };
