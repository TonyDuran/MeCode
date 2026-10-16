'use strict';
// Diagnostic only (never fails the job): bounded, read-only listing of containers carrying the app label, with identity/creation/status metadata.
// Usage: node scripts/leak-probe.cjs <phase>
const { psRows } = require('./lib/launcher-stop.cjs');
const phase = String(process.argv[2] || 'unspecified')
  .replace(/[^\w .:/-]/g, '_')
  .slice(0, 80);
const at = new Date().toISOString();
const r = psRows(['mecode.app=mecode-v2']);
if (!r.ok) console.log(`LEAK-PROBE phase=${JSON.stringify(phase)} at=${at} docker-unanswered=${JSON.stringify(r.error)}`);
else {
  console.log(`LEAK-PROBE phase=${JSON.stringify(phase)} at=${at} count=${r.rows.length}`);
  for (const c of r.rows.slice(0, 20))
    console.log(
      `LEAK-PROBE phase=${JSON.stringify(phase)} id=${c.id.slice(0, 12)} name=${c.names} state=${c.state} status=${JSON.stringify(c.status)} created=${JSON.stringify(c.createdAt)} image=${c.image} labels=${JSON.stringify(c.labels)}`,
    );
}
