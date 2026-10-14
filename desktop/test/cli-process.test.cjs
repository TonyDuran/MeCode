// Real trusted Python process, invalid input only. Never a valid submission.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { userInfo } = require('node:os');

const cli = path.resolve(__dirname, '../../prototypes/docker-engine/bridge_cli.py');
function invoke(input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-B', cli], {
      cwd: path.dirname(cli), env: { HOME: userInfo().homedir, PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let output = ''; let error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('trusted CLI did not finish')); }, 5000);
    child.on('error', reject);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { error += data; });
    child.stdin.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0); assert.equal(error, '');
        assert.ok(Buffer.byteLength(output) <= 1024);
        assert.equal(output.trim().split('\n').length, 1);
        resolve(JSON.parse(output));
      } catch (error) { reject(error); }
    });
    if (input !== null) child.stdin.end(input);
  });
}

test('absolute isolated Python CLI rejects malformed/oversized stdin with one bounded record',
  { skip: process.platform !== 'linux' }, async () => {
    for (const input of ['', '{', '{}', 'x'.repeat(100001)]) {
      assert.deepEqual(await invoke(input), { status: 'INVALID_INPUT', verdict: null,
        reason: 'invalid_source_or_problem', elapsed_s: null });
    }
  });

test('real CLI input deadline terminates a stdin reader with no EOF and no submission',
  { skip: process.platform !== 'linux' }, async () => {
    assert.deepEqual(await invoke(null), { status: 'UNAVAILABLE', verdict: null,
      reason: 'input_timeout', elapsed_s: null });
  });
