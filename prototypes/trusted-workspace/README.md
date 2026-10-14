# Trusted workspace fixture demonstration (APP-JUDGE-1)

The original headless prototype received Talos review, Themis independent QA and
Metis bounded acceptance. This docs/manifests/CI correction is a new binding:
affected Talos review, Themis verification and PM final-binding confirmation
remain pending. No commit/push/PR, merge, hosted CI success or release is claimed.
This is a headless external-Chrome workspace with static fixed-fixture evidence.
It is NOT a bundled app, a live submission engine, or a safe arbitrary-code judge.
Run/Submit remain semantically disabled with a persistent associated notice:
“Run and Submit are unavailable in this prototype. Live judging is not integrated
or verified. Edit your draft; check save status above. It has not been judged.”
Fixture success is never saved as learner progress or a verdict on a draft.
The copy does not promise saving: when corrupt state blocks saving, the live save
status above the notice says so. At 1024x768 the editor grid row floors at its
content height (`minmax(min-content,1fr)`), so the corrupt-state feedback and the
whole notice are readable on fresh reopen without inner scrolling
(`test_engine_unavailable.BrowserCorruptLayout`, both themes).

## Boundary and encoding

A developer invokes `generate.py` separately. It imports the unchanged merged
trusted runner only after verifying its pinned source hashes. Its four fixed
fixtures use the existing positive case [1, 2, 3, 4], literal oracle 10, run budget
0.5 seconds and the runner's existing cleanup budget 2 seconds. Unexpected status,
lockout, unconfirmed cleanup or failed direct-child reaping aborts generation;
no fabricated verdict is substituted. No editor, storage, renderer arguments,
fixture choice, source path or commands are accepted by the generator.

`fixture-evidence.json` is generated data (cap 256 KiB). `index.html` is generated
from `workspace.html.in` with the identical JSON bytes in an inert
`application/json` script element; angle brackets/ampersands are Unicode-escaped.
The whole generated page also has a 256 KiB cap. This avoids file-URL fetch
permissions, a server, native IPC, and executable data wrappers. The small
`evidence-contract.js` contains only generated digest/source identity constants.
No dynamically loaded scripts, eval, native APIs or renderer-triggered runner.
The anonymous CDP pipe in the Python QA harness is developer-only, not a renderer
bridge and not an app execution feature.

The inspector checks exact schema/fields, declared case and literal oracle,
ordered fixture identities/statuses, merged source hashes/revision, receipts,
stream caps and whole-artifact SHA-256. Data must be at most seven days old;
future timestamps exceeding five minutes' clock skew are rejected. Regenerate
explicitly to refresh expired evidence, then rebind review to the new manifest.
Missing, malformed, oversized, stale or mismatched evidence clears recorded
verdicts and produces “Fixture evidence unavailable”, never a fallback pass.
Strings are rendered with textContent, never HTML. “Fixture demonstration, not
your submission” is always explicit. Inspector code never reads the draft.

These local hashes detect accidental substitution/corruption; they are not digital
signatures, remote attestations or protection against someone editing all assets.
Runner subprocess controls are NOT a sandbox. The complete raw generation receipt,
full process argv and unsanitized traceback stay outside the repository. Public
bounded records include stdout, normalized stderr, benign PIDs, original stream
byte counts and cleanup/reaped/PID-absent flags. Public stderr only replaces the
exact traceback source filename with `fixtures.py`. QA compares the complete
normalized records to the external raw receipt.

## Prerequisites and local checks

Use already-installed Python 3 and Google Chrome with its existing Linux sandbox.
No installation, download, server, port, external access or host-control changes.
Reserve a dedicated external task-owned state directory and set
`MECODE_LOCAL_STATE` to its absolute path. The tools reject a path inside or
containing this repository. No default browser profile or sealed PoC is reused.
Keep that variable set for every command below; do not use an unrelated profile.

From this prototype directory:

    python3 -B -W error generate.py
    python3 -B inventory.py --write
    python3 -B -W error test_evidence.py
    python3 -B -W error test_app.py
    python3 -B -W error test_themis_r1.py --tag a1 --expected-source-manifest DIGEST
    python3 -B inventory.py

Replace DIGEST with the SOURCE-SHA256.txt digest printed by inventory.py. R1 tags
are one or two lowercase alphanumerics; each tag requires new profile/report paths
and refuses reuse. Do not reseal during a review/QA pass or hand-edit generated
data. Inventory changes require a new explicit binding and affected review.

From the repository root, existing judge regression command:

    python3 -B -W error -m unittest discover -s prototypes/trusted-judge -v

test_evidence.py adds adversarial schemas, identities, stale-clock checks, literal
oracle/raw-receipt comparison, HTML-looking strings, truthful error UI, real mouse,
keyboard and forced DOM Run/Submit events, executable-looking draft/storage edits,
and exact clean-close/fresh-process draft/theme/full-envelope readback.
test_app.py retains the accepted 51-check persistence/keyboard/layout suite.
test_themis_r1.py adapts the independent retained three-case recovery race test:
held hashing, held real transaction completion and genuine recovery abort.
Running its copy here is Prax regression evidence, NOT independent Themis QA.

Reports, screenshots, Chrome logs/profile/cache/HOME/XDG/temp state and lock are
confined to MECODE_LOCAL_STATE. Resource checks require at least 5 GiB free,
less than 1 GiB task-owned allocated disk and sample a 2 GiB browser-tree RSS cap.
Chrome's sandbox is unchanged. Offline CDP emulation verifies local page requests,
not whole-browser network isolation. Capacity guards are sampled, not quotas.

## Persistence preserved, not migrated

`persistence.js` is byte-identical to the accepted R1-corrected source. Same
IndexedDB version 1, fixed sum-array-v1 key, checked draft/theme envelopes,
completion-gated acknowledgements, explicit retry and bounded corruption archive.
Candidate browser state is separate; no accepted profile is migrated or edited.
Unicode/multiline/empty drafts and themes must survive a clean exit followed by a
new browser process on the same file origin/profile. Drafts stay explicitly
unjudged. Close only after “Saved locally”; unsaved text can be lost on termination.
No power-loss/fsync, physical disk-full, universal eviction or crash guarantee.

## Source provenance and inventory

PROVENANCE.json binds the accepted P3-APP-1 source manifest and exact original
hash of each source-only input. No profiles, logs, historical result dataset,
accepted-ui snapshots, seals or old evidence are copied into this prototype.

Byte-identical copies from the accepted source: persistence.js, styles.css.
app-styles.css additionally gives the persistent execution notice readable theme
text, prevents its container from shrinking, and reserves editor row space so
wrapped copy is not clipped by the recorded inspector (ENGINE-UNAVAILABLE-UX-1).
Adaptations:
- index.html → workspace.html.in: fresh fixture labels, honest disabled-execution
  note, inert evidence slot and validation scripts; original layout retained.
- app.js: draft/theme/navigation retained; historical-record rendering replaced
  with validated static fixture rendering and fail-closed evidence UI.
- runtime.py: external state location/lock/resource inventory; removed standalone
  headed launcher. Existing guard semantics retained (R2 below).
- chrome_pipe.py: only output/profile roots redirected outside the repository.
- test_app.py: source inventory names and truthful UI text assertions updated.
- test_themis_r1.py: only state/report roots moved outside the repository; recovery
  test body/independent assertions retained.
New: generate.py, evidence.js, test_evidence.py, inventory.py and this README.
Generated: fixture-evidence.json, evidence-contract.js, index.html and manifests.
The merged judge at c1a2af5386251fac1a66f41fdea77255b994851e is unchanged;
its exact runner/fixture SHA-256 values are pinned in generate.py and the evidence.
SOURCE-SHA256.txt binds non-generated sources/docs; ARTIFACT-SHA256.txt additionally
binds generated assets and SOURCE-SHA256.txt. No private host paths or raw logs
belong in those manifests or assets.

## Limits, review and rollback

The original accepted binding remains historical; it does not approve this
corrected inventory/workflow. Affected Talos review, Themis inventory/docs/data
comparison and workflow/local-command verification, and PM final-binding
confirmation are still required for this revision. No commit/push/PR yet.

The workflow adds Chrome-free workspace inventory/member verification and only
the two existing boundary tests plus ENGINE-UNAVAILABLE-UX-1 static tests (run from this prototype directory with a fresh
external `MECODE_LOCAL_STATE` under `RUNNER_TEMP`):

    python3 -B inventory.py
    sha256sum -c SOURCE-SHA256.txt
    sha256sum -c ARTIFACT-SHA256.txt
    python3 -B -W error -m unittest -v test_evidence.StaticBoundary.test_browser_has_no_execution_or_native_transport test_evidence.StaticBoundary.test_generator_identity_failure_before_any_launch test_engine_unavailable.StaticNotice

This is inventory/static boundary coverage, not renderer/persistence integration
coverage. Browser rejection/rendering/freshness, forced events, real persistence,
R1 recovery and the original raw-receipt cross-check remain independently verified
local evidence, not hosted CI coverage. No private receipt is copied into CI.
Hosted execution and runner compatibility remain unobserved; local success is
not full workspace CI green or release proof.
Stop for any new native bridge, schema migration, dependency or host permission.
Headed behavior, bundled delivery, arbitrary-code isolation, Mac, release and
network-isolation certification are unproven/out of scope.

Inherited R2 remains: runtime.py resource breach cleanup is one best-effort
SIGTERM pass over the observed child tree, not a confirmed/escalating security
boundary. Normal QA shutdown uses Browser.close and checks direct browser exit;
this does not resolve R2 or prove arbitrary-child termination safety.

## ENGINE-UNAVAILABLE-UX-1 candidate (review/independent QA pending)

This presentation-only slice replaces the execution explanation without changing
app.js, persistence.js, evidence validation, runtime or judge/controller code.
The notice is ordinary persistent text, not an alert or tooltip; existing
aria-describedby associates it with both native disabled buttons and the draft.
Save acknowledgement remains separate and completion-gated, not promised by the
notice. No daemon outage, engine check, isolation guarantee or learner verdict.

To rebuild only presentation while retaining the exact existing fixture bytes,
contract and historical local receipt, use `python3 -B generate.py --render-existing`
then `python3 -B inventory.py --write`. This verifies pinned source/fixture digest
and escapes/caps before writing only index.html; it launches no fixtures and does
not refresh their timestamp. An expired fixture still fails closed. Default
`generate.py` continues to generate new evidence only when separately intended.
PROVENANCE.json remains historical accepted-source provenance, not this candidate's
manifest. No historical receipt/profile is rewritten or imported for this slice.

`python3 -B -W error test_engine_unavailable.py` adds focused static and headless
regressions: browser AX description/disabled state, both themes at 1440x900 and
1024x768, actual mouse/keyboard and forced DOM actions (including QA removal of
disabled), unchanged draft envelope/fixture inspector/targets, fresh-process exact
reopen and genuine save abort/retry with visible feedback. Use a fresh task-owned
state path; its ux profile refuses reuse. Reports/captures remain outside the repo.
Chrome Unix socket paths require short QA TMPDIR paths; a task-local QA environment
wrapper may shorten only that path, without changing sandbox flags or host settings.
The new static suite is included in the Chrome-free workflow command above.
Headed/accessibility assistive-technology checks and hosted CI are not claimed.
This candidate needs Talos review and independent Themis QA before Metis acceptance;
it does not satisfy ENGINE-1, SLICE-1, DESIGN-CONFIRMED or release.

Rollback this slice by restoring only its changed files to the base revision and
removing its new test (after preserving wanted task evidence). No database/schema
migration or draft rollback is needed.

Rollback of the whole prototype: close only this task's browsers first, back up wanted drafts/quarantine,
then remove this new prototype directory. Separately remove only its dedicated
external state directory if draft deletion is intended. Do not touch accepted
PoCs, merged trusted-judge, other profiles/processes or shared host resources.
