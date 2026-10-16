'use strict';
// Writes a small EXTERNAL demo pack (id `ext-demo`, not bundled) for import tests: node scripts/make-demo-pack.cjs <out.json> [expectedForExample1]
const fs = require('node:fs');
const path = require('node:path');
const core = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'packs', 'core.json'), 'utf8'));
const base = core.problems[0];
const out = process.argv[2];
const ex1 = process.argv[3] || '42';
const pack = {
  schemaVersion: 1, id: 'ext-demo', title: 'External demo pack',
  provenance: { kind: 'original', authors: ['demo'], license: 'CC0-1.0', sources: [] },
  problems: [{
    id: 'double-it', title: 'Double It', difficulty: 'easy', patterns: ['math'],
    statement: 'Read one integer x and print 2*x.',
    inputFormat: 'One integer x.', outputFormat: 'One integer: 2*x.', constraints: ['-1000000 <= x <= 1000000'],
    comparison: 'tokens', starters: base.starters,
    tests: [
      { id: 'example-1', kind: 'example', stdin: '21\n', expected: `${ex1}\n` },
      { id: 'example-2', kind: 'example', stdin: '5\n', expected: '10\n' },
      { id: 'check-neg', kind: 'check', stdin: '-3\n', expected: '-6\n' },
    ],
  }],
};
fs.writeFileSync(out, JSON.stringify(pack, null, 2));
console.log(`wrote ${out}`);
