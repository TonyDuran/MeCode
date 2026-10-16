'use strict';
// T29: the intentionally WRONG dock-pairing baseline counts INDEX pairs (so duplicates inflate the answer). It must stay wrong in exactly that way
// but run in linear time so the FULL111 negative never hits TIME_LIMIT. The old quadratic body is embedded here as the equivalence oracle.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const wrong = path.join(root, 'catalog-dev', 'wrong', 'dock-pairing.py');
const ref = path.join(root, 'catalog-dev', 'refs', 'dock-pairing.py');
const OLD_QUADRATIC = `
import sys
def ints(s): return list(map(int, s.split()))
d = ints(sys.stdin.read())
n, t, a = d[0], d[1], d[2 : 2 + d[0]]
print(sum(1 for i in range(n) for j in range(i + 1, n) if a[i] + a[j] == t))
`;
const py = (args, input) => cp.spawnSync('python3', args, { input, encoding: 'utf8', timeout: 60000 });
const lcg = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const inputOf = (a, t) => `${a.length} ${t}\n${a.join(' ')}\n`;

test('T29 linear wrong baseline == old quadratic index-pair count on duplicate-heavy inputs, and still differs from the distinct-weight-pair reference', () => {
  const rnd = lcg(29);
  let differs = 0;
  for (let k = 0; k < 120; k++) {
    const n = 1 + Math.floor(rnd() * 14);
    const a = Array.from({ length: n }, () => Math.floor(rnd() * 5) - 1).sort((x, y) => x - y); // few distinct values => many duplicates
    const t = Math.floor(rnd() * 7) - 2;
    const inp = inputOf(a, t);
    const o = py(['-c', OLD_QUADRATIC], inp);
    const nw = py([wrong], inp);
    assert.equal(nw.status, 0, nw.stderr);
    assert.equal(nw.stdout.trim(), o.stdout.trim(), `old vs new on ${JSON.stringify(inp)}`);
    if (py([ref], inp).stdout.trim() !== nw.stdout.trim()) differs++;
  }
  assert.ok(differs > 10, `wrong baseline must still disagree with the distinct-pair reference on duplicates (differed ${differs}x)`);
  const ex = '5 4\n2 2 2 2 2\n'; // 10 index pairs, 1 distinct weight pair
  assert.equal(py([wrong], ex).stdout.trim(), '10');
  assert.equal(py([ref], ex).stdout.trim(), '1');
});

test('T29 wrong baseline is fast on the unchanged n=9000 fixture shape (values 0..200, target 100) and agrees with the quadratic oracle', () => {
  const rnd = lcg(9000);
  const a = Array.from({ length: 9000 }, () => Math.floor(rnd() * 201)).sort((x, y) => x - y);
  const inp = inputOf(a, 100);
  const t0 = Date.now();
  const nw = py([wrong], inp);
  const ms = Date.now() - t0;
  assert.equal(nw.status, 0, nw.stderr);
  assert.ok(ms < 1500, `linear baseline took ${ms}ms`);
  assert.equal(nw.stdout.trim(), py(['-c', OLD_QUADRATIC], inp).stdout.trim());
  assert.ok(fs.existsSync(wrong));
});

test('T29 wrong baseline scales linearly (n=40000, well past the catalog limit, still fast; a quadratic loop needs ~16x the 9000 work)', () => {
  const rnd = lcg(40000);
  const a = Array.from({ length: 40000 }, () => Math.floor(rnd() * 201)).sort((x, y) => x - y);
  const t0 = Date.now();
  const nw = py([wrong], inputOf(a, 100));
  const ms = Date.now() - t0;
  assert.equal(nw.status, 0, nw.stderr);
  assert.ok(ms < 1500, `took ${ms}ms`);
});
