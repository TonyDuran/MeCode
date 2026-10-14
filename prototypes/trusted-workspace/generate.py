"""Developer-only fixed fixture generation. No editor/storage/renderer input."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from runtime import ROOT, STATE, Guard

REVISION = 'c1a2af5386251fac1a66f41fdea77255b994851e'
HASHES = {'runner.py': 'ab27a57cec941488046e79a68fe4d828cbbd83b06a3569d8fbc395c2e9f2475b',
          'fixtures.py': 'dd6ed0b012b76c3f3d7d8a511f5ddc2f3fdd9b6056c39d35b8345ef0c9437fe0'}
FIXTURES = ('correct', 'wrong', 'exception', 'sleep_loop')
EXPECTED = ('ACCEPTED', 'WRONG_ANSWER', 'RUNTIME_ERROR', 'TIME_LIMIT')
CAP = 256 * 1024
JUDGE = ROOT.parent / 'trusted-judge'


def identity_check():
    for name, expected in HASHES.items():
        if hashlib.sha256((JUDGE/name).read_bytes()).hexdigest() != expected:
            raise RuntimeError('Merged judge identity differs; review required')


def generate():
    identity_check()  # Before import or launch.
    guard = Guard()
    try:
        spec = importlib.util.spec_from_file_location('trusted_runner', JUDGE/'runner.py')
        if spec is None or spec.loader is None:
            raise RuntimeError('Runner loader unavailable')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        runner = module.Runner()
        raw, records, receipts = [], [], []
        for fixture, expected in zip(FIXTURES, EXPECTED):
            result = runner.run(fixture, [1, 2, 3, 4], budget=0.5)
            raw.append(result)
            # Assert observed results; never substitute a verdict on failure.
            if not runner.available or result['verdict'] != expected or result['cleanup_confirmed'] is not True:
                raise RuntimeError('Fixed-fixture generation failed; no artifact published')
            try:
                os.waitpid(result['pid'], os.WNOHANG)
            except ChildProcessError:
                reaped = True
            else:
                raise RuntimeError('Child was not reaped')
            try:
                os.kill(result['pid'], 0)
            except ProcessLookupError:
                absent = True
            else:
                raise RuntimeError('Child PID still exists')
            clean = dict(result)
            # Only normalize traceback source path; raw stream remains in local receipt.
            clean['stderr'] = clean['stderr'].replace(str(module.FIXTURE_FILE), 'fixtures.py')
            records.append(clean)
            receipts.append({'fixture': fixture, 'reaped': reaped, 'pid_absent': absent,
                             'actual_argv': [sys.executable, '-I', '-B', str(module.FIXTURE_FILE), fixture]})
        generated = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        artifact = {'schema_version': 1, 'problem_id': 'sum-array-v1', 'case_id': 'positive',
                    'nums': [1, 2, 3, 4], 'oracle': 10, 'generated_utc': generated,
                    'judge_revision': REVISION, 'source_sha256': HASHES,
                    'invocation': 'Runner.run(fixture, [1, 2, 3, 4], budget=0.5)',
                    'records': records, 'termination': [{k:v for k,v in r.items() if k != 'actual_argv'} for r in receipts]}
        # Escaping prevents a JSON string from terminating the inert script element.
        text = json.dumps(artifact, ensure_ascii=True, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
        template = (ROOT/'workspace.html.in').read_text()
        if template.count('@@EVIDENCE@@') != 1:
            raise RuntimeError('Invalid template marker')
        page = template.replace('@@EVIDENCE@@', text)
        if max(len(text.encode()), len(page.encode())) > CAP:
            raise RuntimeError('Static artifact exceeds 256 KiB')
        identity_check()
        receipt = {'generated_utc': generated, 'artifact_sha256': hashlib.sha256(text.encode()).hexdigest(),
                   'raw_records': raw, 'termination': receipts, 'source_sha256': HASHES,
                   'generator_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        (STATE/'generation-receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
        # Pin whole bytes as well as expected source/case identities. Not a signature.
        contract = {'sha256': receipt['artifact_sha256'], 'judge_revision': REVISION, 'source_sha256': HASHES}
        (ROOT/'evidence-contract.js').write_text("'use strict';\nconst EVIDENCE_CONTRACT = Object.freeze("+json.dumps(contract)+');\n')
        (ROOT/'fixture-evidence.json').write_text(text)
        (ROOT/'index.html').write_text(page)
        print(json.dumps({'bytes': len(text.encode()), 'page_bytes': len(page.encode()),
                          'sha256': receipt['artifact_sha256'], 'generated_utc': generated,
                          'verdicts': [r['verdict'] for r in records], 'children_reaped_and_absent': True}))
    finally:
        guard.close()


def render_existing():
    """Presentation-only rebuild; preserve fixture bytes and historical receipts."""
    identity_check()
    text = (ROOT/'fixture-evidence.json').read_text()
    contract_source = (ROOT/'evidence-contract.js').read_text()
    prefix = "'use strict';\nconst EVIDENCE_CONTRACT = Object.freeze("
    if not contract_source.startswith(prefix) or not contract_source.endswith(');\n'):
        raise RuntimeError('Invalid evidence contract')
    contract = json.loads(contract_source[len(prefix):-3])
    if contract != {'sha256': hashlib.sha256(text.encode()).hexdigest(),
                    'judge_revision': REVISION, 'source_sha256': HASHES}:
        raise RuntimeError('Existing fixture identity differs; no page published')
    template = (ROOT/'workspace.html.in').read_text()
    if template.count('@@EVIDENCE@@') != 1 or any(c in text for c in '<>&'):
        raise RuntimeError('Invalid template or unescaped evidence')
    page = template.replace('@@EVIDENCE@@', text)
    if max(len(text.encode()), len(page.encode())) > CAP:
        raise RuntimeError('Static artifact exceeds 256 KiB')
    (ROOT/'index.html').write_text(page)
    print(json.dumps({'mode': 'render-existing; no fixture launch',
                      'fixture_sha256': contract['sha256'],
                      'page_sha256': hashlib.sha256(page.encode()).hexdigest()}))


if __name__ == '__main__':
    if sys.argv[1:] == ['--render-existing']:
        render_existing()
    elif not sys.argv[1:]:
        generate()
    else:
        raise SystemExit('Usage: generate.py [--render-existing]; fixed evidence only')
