'use strict';
// Toolchain assertions: build/test Node + npm must equal the pinned versions, installed dev dependencies must equal package.json pins
// AND the lockfile. Also LOGS (does not assert) the distinct runtime identities: Docker engine mode, guest toolchain versions, Chrome.
// Usage: node scripts/verify-toolchain.cjs [--runtime]   (--runtime adds the Docker identity report)
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const wantNode = read('.node-version').trim();
const wantNpm = pkg.engines && pkg.engines.npm;
const problems = [];
const bad = (m) => problems.push(m);

if (process.version !== `v${wantNode}`) bad(`node ${process.version} != pinned v${wantNode} (.node-version)`);
const npmV = cp.execFileSync('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
if (npmV !== wantNpm) bad(`npm ${npmV} != pinned ${wantNpm} (package.json engines.npm)`);
if (pkg.engines && pkg.engines.node !== wantNode) bad(`package.json engines.node ${pkg.engines.node} != .node-version ${wantNode}`);

const rootLock = (lock.packages && lock.packages['']) || {};
for (const [name, ver] of Object.entries(pkg.devDependencies || {})) {
  if (!/^\d+\.\d+\.\d+$/.test(ver)) bad(`${name}: "${ver}" is not an exact pin`);
  if ((rootLock.devDependencies || {})[name] !== ver) bad(`${name}: lockfile root spec ${(rootLock.devDependencies || {})[name]} != ${ver}`);
  const lockedVer = lock.packages[`node_modules/${name}`] && lock.packages[`node_modules/${name}`].version;
  if (lockedVer !== ver) bad(`${name}: locked version ${lockedVer} != ${ver}`);
  let installed = null;
  try {
    installed = JSON.parse(read(`node_modules/${name}/package.json`)).version;
  } catch {
    bad(`${name}: not installed (run npm ci)`);
  }
  if (installed && installed !== ver) bad(`${name}: installed ${installed} != pinned ${ver}`);
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length) bad('runtime dependencies must stay empty (zero-dependency app)');

console.log(`build identity: node ${process.version}, npm ${npmV}, platform ${process.platform}/${process.arch}`);
console.log(
  `dev pins: ${Object.entries(pkg.devDependencies)
    .map(([k, v]) => `${k}@${v}`)
    .join(', ')}`,
);

if (process.argv.includes('--runtime')) {
  const run = (c, a) => {
    try {
      return cp.execFileSync(c, a, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      return `unavailable (${String(e.message).split('\n')[0].slice(0, 100)})`;
    }
  };
  console.log(`docker client/server: ${run('docker', ['version', '--format', '{{.Client.Version}} / {{.Server.Version}}'])}`);
  console.log(`docker security options (rootless shows "rootless"): ${run('docker', ['info', '--format', '{{.SecurityOptions}}'])}`);
  console.log(`docker cgroup: ${run('docker', ['info', '--format', '{{.CgroupDriver}} v{{.CgroupVersion}}'])}`);
  console.log(`engine image id: ${run('docker', ['image', 'inspect', 'mecode-engine:v2', '--format', '{{.Id}}'])}`);
  console.log(
    `guest toolchains (separate from build Node): ${run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', 'mecode-engine:v2', '-c', 'python3 --version; node --version; g++ --version | head -1; gcc --version | head -1']).replace(/\n/g, ' | ')}`,
  );
}

if (problems.length) {
  console.error(`TOOLCHAIN-FAIL\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log('TOOLCHAIN-OK');
