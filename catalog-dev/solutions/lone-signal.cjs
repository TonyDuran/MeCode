// Regression solution (JavaScript) for lone-signal: per-bit counts modulo 3 over 64-bit two's complement.
const d = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = d[0];
const cnt = new Array(64).fill(0);
for (let k = 1; k <= n; k++) {
  const b = BigInt.asUintN(64, BigInt(d[k]));
  for (let i = 0; i < 64; i++) if ((b >> BigInt(i)) & 1n) cnt[i]++;
}
let res = 0n;
for (let i = 0; i < 64; i++) if (cnt[i] % 3) res |= 1n << BigInt(i);
console.log(String(BigInt.asIntN(64, res)));
