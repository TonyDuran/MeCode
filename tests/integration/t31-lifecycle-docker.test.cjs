'use strict';
// T31 REAL Docker lifecycle check (focused; NOT a fake daemon). Runs only with MECODE_REAL_DOCKER=1 and the provisioned image mecode-engine:v2.
// Exercises the create/start split against the real daemon: normal start -> stop, and stop requested at the EARLIEST point of startup (the moment the
// backend enters 'starting', i.e. while the real `docker create` is being issued). Asserts the exact install-labelled container set is empty afterwards.
// It cannot force the daemon to publish a Created object after a client close (that ordering is modeled in t31-lifecycle.test.cjs with a fake daemon).
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { Backend } = require('../../src/main/backend.cjs');

const on = process.env.MECODE_REAL_DOCKER === '1';
const opts = { skip: on ? false : 'NOT RUN: set MECODE_REAL_DOCKER=1 with the provisioned mecode-engine:v2 image', timeout: 120000 };
const owned = (installId) =>
  cp.execFileSync('docker', ['ps', '-aq', '--filter', 'label=mecode.app=mecode-v2', '--filter', `label=mecode.install=${installId}`], { encoding: 'utf8', timeout: 15000 }).trim();

test('REAL docker: create+start reaches ready, stop confirms exact removal, nothing owned remains, no reprepare', opts, async () => {
  const installId = crypto.randomUUID();
  const b = new Backend({ installId });
  try {
    const st = await b.start();
    assert.equal(st.state, 'ready', st.reason);
    assert.equal(owned(installId).split('\n').filter(Boolean).length, 1, 'exactly one owned container while ready');
  } finally {
    const r = await b.stop();
    assert.equal(r.confirmed, true);
    assert.equal(owned(installId), '', 'owned container remains after stop');
  }
  await b.start();
  assert.equal(owned(installId), '', 'no worker after a successful stop');
});

test('REAL docker: stop issued at the earliest startup point (state "starting", create in flight) leaves nothing and confirms', opts, async () => {
  for (let i = 0; i < 3; i++) {
    const installId = crypto.randomUUID();
    const b = new Backend({ installId });
    let stopping = null;
    b.on('status', (s) => {
      if (s.state === 'starting' && !stopping) stopping = b.stop();
    });
    const starting = b.start();
    let r;
    try {
      await starting;
      assert.ok(stopping, 'stop was requested at "starting"');
      r = await stopping;
    } finally {
      if (!stopping) await b.stop();
    }
    assert.equal(r.confirmed, true, `iteration ${i}`);
    assert.equal(owned(installId), '', `iteration ${i}: owned container remains after stop`);
  }
});
