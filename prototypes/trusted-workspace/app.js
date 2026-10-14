'use strict';
// Draft UI only; inspector consumes validated static data, never editor text.
const $ = id => document.getElementById(id);
const symbols = ['✓', '≠', '!', '◷'];
const explanations = [
  'The recorded correct fixture returned the exact integer sum.',
  'The recorded wrong fixture adds one to the correct sum.',
  'The recorded exception fixture raised a benign RuntimeError.',
  'The recorded sleep-loop fixture exceeded its recorded time budget.'
];
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function selectNav(which) {
  ['problem-nav', 'results-nav'].forEach(id => {
    if (id === which) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  });
}
function openRecorded(moveFocus = false) {
  $('recorded-content').hidden = false;
  $('recorded-intro').hidden = true;
  $('record-action').setAttribute('aria-expanded', 'true');
  selectNav('results-nav');
  if (moveFocus) $('inspector').focus();
}
$('theme').addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('theme').textContent = light ? 'Dark theme ◐' : 'Light theme ◐';
  $('theme').setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
});
$('problem-nav').addEventListener('click', () => { selectNav('problem-nav'); $('statement').focus(); });
$('results-nav').addEventListener('click', () => openRecorded(true));
$('record-action').addEventListener('click', () => {
  const expanded = $('record-action').getAttribute('aria-expanded') === 'true';
  $('recorded-content').hidden = expanded;
  $('recorded-intro').hidden = !expanded;
  $('record-action').setAttribute('aria-expanded', String(!expanded));
  selectNav(expanded ? 'problem-nav' : 'results-nav');
});
const draft = $('draft');
function updateDraft() {
  const lines = draft.value.split('\n');
  $('line-numbers').textContent = lines.map((_, i) => i + 1).join('\n');
  const before = draft.value.slice(0, draft.selectionStart).split('\n');
  $('position').textContent = `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
}
draft.addEventListener('input', () => { $('draft-status').textContent = 'Edited · not run'; updateDraft(); });
['click', 'keyup', 'select'].forEach(event => draft.addEventListener(event, updateDraft));
draft.addEventListener('scroll', () => { $('line-numbers').scrollTop = draft.scrollTop; });
updateDraft();

function renderEvidence(data) {
  const box = element('div', undefined, 'example');
  box.append(element('div', 'Declared case: positive', 'example-label'), element('code', '[1,2,3,4] → 10'));
  $('statement-examples').replaceChildren(box);
  $('contract-hashes').textContent = JSON.stringify(data.source_sha256, null, 2);
  const controls = $('verdict-controls'); controls.replaceChildren();
  function select(index) {
    const r = data.records[index];
    controls.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === index)));
    const detail = $('record-detail'); detail.replaceChildren();
    detail.append(element('h3', r.verdict), element('p', explanations[index]),
      element('p', `Fixture: ${r.fixture} · Case: ${data.case_id} · PID: ${r.pid}`),
      element('pre', `Recorded stdout: ${JSON.stringify(r.stdout)}\nRecorded stderr: ${JSON.stringify(r.stderr)}\nExit: ${r.returncode} · Cleanup: ${r.cleanup_confirmed}\nBudget: ${r.run_budget_s} s · Elapsed: ${r.elapsed_s} s`));
    $('source-detail').textContent = JSON.stringify(data, null, 2);
  }
  data.records.forEach((r, i) => {
    const button = element('button', `${symbols[i]} ${r.verdict}`);
    button.dataset.verdict = r.verdict;
    button.addEventListener('click', () => select(i)); controls.append(button);
  });
  select(0);
}
async function loadFixtureEvidence() {
  $('evidence-status').dataset.state = 'pending';
  $('verdict-controls').replaceChildren(); $('record-detail').replaceChildren();
  $('source-detail').textContent = ''; $('contract-hashes').textContent = '';
  $('statement-examples').replaceChildren();
  try {
    const node = $('fixture-evidence');
    const data = await FixtureEvidence.validate(node ? node.textContent : null);
    renderEvidence(data);
    $('evidence-status').textContent = `Fixture demonstration, not your submission. Generated ${data.generated_utc}.`;
    $('evidence-status').dataset.state = 'ready';
  } catch (error) {
    $('verdict-controls').replaceChildren(); $('record-detail').replaceChildren();
    $('source-detail').textContent = ''; $('contract-hashes').textContent = '';
    $('evidence-status').textContent = `Fixture evidence unavailable: ${error.message}. No verdict on your draft.`;
    $('evidence-status').dataset.state = 'error';
  }
}
loadFixtureEvidence();
