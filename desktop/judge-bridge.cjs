// Self-authored by Talos. Trusted main-process adapter; no host source execution.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { readJudgeAssets } = require('./judge-assets.cjs');

const SOURCE_CAP = 16384;
const INPUT_CAP = 100000;
const OUTPUT_CAP = 1024;
const DEADLINE_MS = 20000;
const GRACE_MS = 8000;
const unavailable = reason => ({ status: 'UNAVAILABLE', verdict: null, reason, elapsed_s: null });
const invalid = () => ({ status: 'INVALID_INPUT', verdict: null,
  reason: 'invalid_source_or_problem', elapsed_s: null });

function validRequest(request) {
  return request !== null && typeof request === 'object' && !Array.isArray(request)
    && Object.keys(request).sort().join(',') === 'problemId,source'
    && request.problemId === 'sum-array-v1' && typeof request.source === 'string'
    && request.source.length <= SOURCE_CAP && Buffer.byteLength(request.source, 'utf8') <= SOURCE_CAP
    // Buffer would otherwise silently replace unpaired UTF-16 surrogates.
    && Buffer.from(request.source, 'utf8').toString('utf8') === request.source;
}

function parseReply(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // CLI emits a fixed-order single record. Reject duplicate/escaped keys, extra
  // fields/records and arbitrary strings before JSON.parse can normalize them.
  const grammar = /^\{"status":"(JUDGED|UNAVAILABLE|INVALID_INPUT)","verdict":(null|"ACCEPTED"|"WRONG_ANSWER"|"RUNTIME_ERROR"),"reason":(null|"engine_unavailable"|"invalid_source_or_problem"|"input_timeout"|"linux_only"),"elapsed_s":(null|[0-9.eE+\-]+)\}\n$/;
  if (!grammar.test(text)) throw new Error('protocol');
  const result = JSON.parse(text);
  if (result.status === 'JUDGED') {
    if (result.verdict === null || result.reason !== null || typeof result.elapsed_s !== 'number'
        || !Number.isFinite(result.elapsed_s) || result.elapsed_s < 0 || result.elapsed_s > 28) throw new Error('protocol');
  } else if (result.verdict !== null || result.reason === null || result.elapsed_s !== null
      || (result.status === 'INVALID_INPUT' && result.reason !== 'invalid_source_or_problem')) {
    throw new Error('protocol');
  }
  return result;
}

function createJudgeBridge({ indexPath, cliPath, home, platform, optIn, isPackaged, spawnImpl = spawn }) {
  if (![indexPath, cliPath, home].every(value => typeof value === 'string' && path.isAbsolute(value))) {
    throw new Error('absolute trusted paths required');
  }
  const documentURL = pathToFileURL(indexPath).href;
  const enabled = platform === 'linux' && isPackaged === true && optIn === '1';
  const gateReason = platform !== 'linux' ? 'linux_only'
    : isPackaged !== true ? 'packaged_required'
    : enabled ? 'experimental_opt_in_not_health' : 'opt_in_required';
  let owner = null;
  let generation = 0;
  let active = null;
  let latched = false;
  let closing = false;

  function authorized(event) {
    try {
      return owner !== null && !owner.isDestroyed() && event.sender === owner
        && event.senderFrame != null && event.senderFrame === owner.mainFrame
        && event.senderFrame.url === documentURL && owner.getURL() === documentURL;
    } catch { return false; }
  }

  function invalidate() {
    generation += 1;
    if (active) active.cancel('stale_frame');
  }

  function bind(contents) {
    invalidate();
    owner = contents;
    // Ignore old windows after replacement; keep one process-wide admission gate.
    const invalidateOwner = () => { if (owner === contents) invalidate(); };
    // Electron 44.7.2 WebContentsDidStartNavigationEventParams, not deprecated
    // positional arguments. Same-document URL changes still fail authorized().
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) invalidateOwner();
    });
    contents.on('render-process-gone', invalidateOwner);
    contents.on('destroyed', invalidateOwner);
  }

  function capabilities(event) {
    return authorized(event) ? { enabled, reason: gateReason } : { enabled: false, reason: 'untrusted_frame' };
  }

  function run(event, request) {
    if (!authorized(event)) return Promise.resolve(unavailable('untrusted_frame'));
    if (!enabled) return Promise.resolve(unavailable(gateReason));
    if (latched || closing) return Promise.resolve(unavailable('bridge_latched'));
    if (!validRequest(request)) return Promise.resolve(invalid());
    if (active) return Promise.resolve(unavailable('busy'));
    const input = JSON.stringify({ source: request.source, problemId: request.problemId });
    if (Buffer.byteLength(input) > INPUT_CAP) return Promise.resolve(invalid());
    const admittedGeneration = generation;
    const admittedFrame = event.senderFrame;
    try {
      if (path.basename(cliPath) !== 'bridge_cli.py') throw new Error('fixed CLI required');
      readJudgeAssets(path.dirname(cliPath));
    } catch {
      latched = true;
      return Promise.resolve(unavailable('assets_unverified'));
    }
    let child;
    try {
      child = spawnImpl('/usr/bin/python3', ['-I', '-B', cliPath], {
        cwd: path.dirname(cliPath), shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
      });
    } catch {
      latched = true;
      return Promise.resolve(unavailable('launch_failed'));
    }
    let stop;
    const promise = new Promise(resolve => {
      let settled = false;
      let failure = null;
      let used = 0;
      const output = [];
      let grace;
      const deadline = setTimeout(() => stop('bridge_timeout'), DEADLINE_MS);
      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(grace);
        if (result.status === 'UNAVAILABLE') latched = true;
        active = null;
        output.length = 0;
        resolve(result);
      }
      function signal(name) {
        try { child.kill(name); } catch { /* Not proof of termination; retain latch. */ }
      }
      stop = reason => {
        if (settled || failure) return;
        failure = reason;
        latched = true;
        clearTimeout(deadline);
        grace = setTimeout(() => {
          signal('SIGKILL');
          // No close/reap assertion. Never admit again in this app process.
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
          finish(unavailable(failure));
        }, GRACE_MS);
        signal('SIGTERM'); // Python routes TERM through the existing cleanup path.
      };
      child.on('error', () => stop('process_failed'));
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        stream.on('error', () => stop('pipe_failed'));
      }
      child.stdout.on('data', chunk => {
        if (settled || failure) return;
        used += chunk.length;
        if (used > OUTPUT_CAP) stop('output_limit');
        else output.push(Buffer.from(chunk));
      });
      child.stderr.on('data', chunk => {
        if (chunk.length) stop('unexpected_stderr'); // Never retain or forward diagnostics.
      });
      child.once('close', (code, signalName) => {
        if (settled) return;
        if (failure) return finish(unavailable(failure));
        if (!authorized(event) || generation !== admittedGeneration || owner.mainFrame !== admittedFrame) {
          return finish(unavailable('stale_frame'));
        }
        if (code !== 0 || signalName) return finish(unavailable('process_failed'));
        try { finish(parseReply(Buffer.concat(output))); }
        catch { finish(unavailable('invalid_protocol')); }
      });
    });
    active = { cancel: stop, promise };
    try { child.stdin.end(input); } catch { stop('pipe_failed'); }
    return promise;
  }

  function shutdown() {
    closing = true;
    if (!active) return Promise.resolve();
    active.cancel('app_closing');
    return active.promise;
  }

  return { bind, capabilities, run, shutdown };
}

module.exports = { createJudgeBridge, DEADLINE_MS, GRACE_MS };
