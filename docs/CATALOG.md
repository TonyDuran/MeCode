# Bundled catalog (T16)

48 original problems over 18 patterns, shipped as two editable packs seeded into the managed packs folder:

- `packs/core.json` (`mecode-core`): the 3 pre-existing problems `beacon-pairs`, `bracket-ledger`, `steady-streak` (ids, statements, examples
  and original tests retained).
- `packs/mecode-patterns.json` (`mecode-patterns`): 45 new problems.

Both packs are `provenance.kind = original`, `license = CC0-1.0`, `sources = []`. No statement, example or test was copied from LeetCode,
NeetCode or any other site; the 18 pattern names are a coverage taxonomy only. The coverage table (`catalog-dev/COVERAGE.md`, generated) lists
every problem, its pattern, difficulty and the amount of oracle evidence.

## Exact coverage (T01 decision: 12 patterns x 3 + 6 patterns x 2)

| pattern slug   | n   | pattern slug     | n   |
| -------------- | --- | ---------------- | --- |
| arrays-hashing | 3   | graphs           | 3   |
| two-pointers   | 3   | dp-1d            | 3   |
| sliding-window | 3   | dp-2d            | 3   |
| stack          | 3   | greedy           | 3   |
| binary-search  | 3   | linked-lists     | 2   |
| trees          | 3   | tries            | 2   |
| heap           | 3   | advanced-graphs  | 2   |
| backtracking   | 3   | intervals        | 2   |
|                |     | math-geometry    | 2   |
|                |     | bit-manipulation | 2   |

The three retained problems already used the slugs `arrays-hashing`, `stack` and `sliding-window`, so no label was renamed. Difficulty spread:
12 easy / 28 medium / 8 hard. Every problem has >= 2 examples and >= 8 checks (edge, seeded random, one large case); examples carry an explanation except three retained legacy
fixtures kept byte-for-byte (`bracket-ledger` example-1, `steady-streak` example-1 and example-2). Each problem has a complete
STDIN/STDOUT contract with numeric bounds, `tokens` comparison (integer/word tokens only) and honest TODO starters in Python, JavaScript, C++17
and C17.

## Changes to the 3 retained problems (read this before upgrading)

Their ids and original tests are unchanged, but each gained extra checks (>= 8 were required) and `steady-streak` gained C++/C starters, so their
`contentHash` changed. Under the T01 design an ACCEPTED result for the old hash shows as stale until re-submitted; drafts are never discarded.

Upgrading an existing install: the managed packs folder keeps your edits. The seed marker `.packs-seeded` now lists the bundled files already
seeded, so `mecode-patterns.json` is added once on first launch of the new version and is never overwritten or resurrected after you edit or delete it.

## Development workflow (not part of any pack; the app never runs it)

    python3 catalog-dev/catalog.py build    # regenerate packs, catalog-dev/refs, catalog-dev/wrong, COVERAGE.*
    python3 catalog-dev/catalog.py check    # CI gate: verify + assert the committed artifacts are current
    python3 catalog-dev/negative-controls.py
    node scripts/catalog-docker-accept.cjs  # real-container acceptance (needs the mecode-engine:v2 image)

`catalog-dev/problems/*.py` hold, per problem: metadata, the trusted Python reference `solve`, an independent `brute` oracle (all 48 problems),
a deliberately wrong baseline `wrong`, a seeded generator, hand-computed examples and `known` edge cases. Fixtures are deterministic (seeded
from the problem id). `catalog.py` executes the standalone reference program (`catalog-dev/refs/<id>.py`) on every stored case, compares each
brute oracle with the reference on the stored cases and 150 extra seeded cases, and requires each wrong baseline to fail at least one check.
Before any answer comparison it runs an authoring-time DOMAIN validator (`dom=` in the problem registry, trusted dev code, no pack schema or
runtime hook) on every stored and extra seeded input of charging-loop (zero or one valid start), coupled-cars (`k <= n+1`) and cheapest-route
(`u != v`); a violation fails with `DOMAIN violation ...` and the case is excluded from comparison. The container gate
(`scripts/catalog-gate.cjs`) accepts a negative only when it was really judged (WRONG_ANSWER, or one of three recorded TIME_LIMIT
classifications that also contain real wrong-answer cases; never INFRA_ERROR/CANCELLED/COMPILE_ERROR). A run without `--only`/`--skip-wrong` must
produce exactly 111 jobs (48 reference + 48 wrong + 3 regression solutions + 12 starters) to report `fullAcceptance:true`; partial runs report `PARTIAL`.
Stored expected answers come from three sources: hand-written (examples and `known` edges), reference output cross-checked by the brute oracle
(seeded cases) and reference output alone (the large case). The reference output of a seeded/large case is NOT independent evidence by
itself; the brute oracle and hand answers are.

References, wrong baselines, oracles and the licence record are development assets: they are not in the shipped archives and the pack schema
forbids executable hooks.
