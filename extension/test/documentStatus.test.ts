import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_VALUES } from '../src/core';
import {
  applyTextEdits, documentStatus, isStatus, nextStatus, setStatusEdits, STATUS_ICONS, STATUS_MEANINGS, statusBarText,
  statusChoices, valueSpan, type StatusEditOptions,
} from '../src/documentStatus';

const TODAY = '2026-09-30';

/** The text after setting `status`, or the refusal reason. */
function setStatus(text: string, status: string, options: StatusEditOptions = {}): string {
  const result = setStatusEdits(text, status, options);
  return result.ok ? applyTextEdits(text, result.edits) : `refused: ${result.reason}`;
}

test('reads the front matter status', () => {
  assert.deepEqual(documentStatus('---\nstatus: review\n---\n'), { kind: 'known', status: 'review' });
  assert.deepEqual(documentStatus('---\nstatus: "Approved"\n---\n'), { kind: 'known', status: 'approved' }, 'case-insensitive, like the validator');
  assert.deepEqual(documentStatus('---\nstatus: final\n---\n'), { kind: 'unknown', value: 'final' });
  assert.deepEqual(documentStatus('---\nstatus: 2\n---\n'), { kind: 'unknown', value: '2' });
  assert.deepEqual(documentStatus('---\ntitle: X\n---\n'), { kind: 'missing' });
  assert.deepEqual(documentStatus('---\nstatus:\n---\n'), { kind: 'missing' });
  assert.deepEqual(documentStatus('# No front matter\n'), { kind: 'missing' });
  assert.equal(documentStatus('---\nstatus: draft\n').kind, 'error', 'unclosed front matter');
  assert.equal(documentStatus('---\nstatus: [draft\n---\n').kind, 'error', 'invalid YAML');
});

test('status bar text and tooltip for every state', () => {
  assert.deepEqual(statusBarText({ kind: 'known', status: 'review' }), {
    text: '$(eye) Review', tooltip: 'Document status: review — click to change', warning: false,
  });
  assert.deepEqual(statusBarText({ kind: 'missing' }), {
    text: '$(circle-large-outline) No status', tooltip: 'This document has no status — click to set one', warning: false,
  });
  const unknown = statusBarText({ kind: 'unknown', value: 'final' });
  assert.equal(unknown.text, '$(warning) final');
  assert.match(unknown.tooltip, /"final" is not one of draft, review, approved, deprecated, archived/);
  assert.equal(unknown.warning, true);
  const error = statusBarText({ kind: 'error', message: 'Front matter starts with "---" but is never closed.' });
  assert.equal(error.warning, true);
  assert.match(error.tooltip, /never closed\. Fix the front matter/);
  for (const status of STATUS_VALUES) {
    assert.ok(STATUS_ICONS[status] && STATUS_MEANINGS[status], `icon and meaning for ${status}`);
  }
});

test('the picker puts the natural next step first and marks the current status', () => {
  const order = (current?: string) => statusChoices(current).map((c) => c.status);
  assert.deepEqual(order('draft'), ['review', 'draft', 'approved', 'deprecated', 'archived']);
  assert.deepEqual(order('review'), ['approved', 'draft', 'review', 'deprecated', 'archived']);
  assert.deepEqual(order('approved'), ['deprecated', 'draft', 'review', 'approved', 'archived']);
  assert.deepEqual(order('archived'), STATUS_VALUES, 'no next step after archived');
  assert.deepEqual(order(undefined), STATUS_VALUES, 'draft first for a document without a status');
  assert.deepEqual(statusChoices('review').filter((c) => c.current || c.next), [
    { status: 'approved', current: false, next: true },
    { status: 'review', current: true, next: false },
  ]);
  assert.equal(nextStatus('final'), 'draft');
  assert.equal(nextStatus('archived'), undefined);
  assert.ok(isStatus('approved') && !isStatus('Approved') && !isStatus(undefined));
});

test('replaces the status value, keeping quotes, comments and other keys', () => {
  assert.equal(setStatus('---\nsmd: 1\nstatus: draft\ntitle: X\n---\n\nBody\n', 'review'), '---\nsmd: 1\nstatus: review\ntitle: X\n---\n\nBody\n');
  assert.equal(setStatus('---\nstatus: "draft"  # bump when reviewed\n---\n', 'review'), '---\nstatus: "review"  # bump when reviewed\n---\n');
  assert.equal(setStatus("---\nstatus: 'draft'\n---\n", 'approved'), "---\nstatus: 'approved'\n---\n");
  assert.equal(setStatus('---\nstatus:   draft   # note\n---\n', 'review'), '---\nstatus:   review   # note\n---\n');
  assert.equal(setStatus('---\nstatus:\n---\n', 'draft'), '---\nstatus: draft\n---\n', 'empty value');
  assert.equal(setStatus('---\nstatus : draft\n---\n', 'review'), '---\nstatus : review\n---\n');
});

test('an invalid existing value is replaced', () => {
  assert.equal(setStatus('---\nstatus: final # was wrong\n---\n', 'approved'), '---\nstatus: approved # was wrong\n---\n');
  assert.equal(setStatus('---\nstatus: Draft\n---\n', 'draft'), '---\nstatus: draft\n---\n', 'normalized to lowercase');
});

test('keeps CRLF line endings', () => {
  const text = '---\r\nsmd: 1\r\ntitle: X\r\nstatus: draft\r\nupdated: 2026-01-01\r\n---\r\n\r\nBody\r\n';
  assert.equal(setStatus(text, 'review', { today: TODAY }), '---\r\nsmd: 1\r\ntitle: X\r\nstatus: review\r\nupdated: 2026-09-30\r\n---\r\n\r\nBody\r\n');
  assert.equal(setStatus('---\r\ntitle: X\r\n---\r\n', 'draft'), '---\r\ntitle: X\r\nstatus: draft\r\n---\r\n', 'inserted line uses CRLF');
});

test('inserts a missing status after summary, else title, else at the end', () => {
  assert.equal(
    setStatus('---\nsmd: 1\ntitle: X\nsummary: Why.\nowners: ["@a"]\n---\n', 'draft'),
    '---\nsmd: 1\ntitle: X\nsummary: Why.\nstatus: draft\nowners: ["@a"]\n---\n',
  );
  assert.equal(setStatus('---\ntitle: X\ntags: [a]\n---\n', 'draft'), '---\ntitle: X\nstatus: draft\ntags: [a]\n---\n');
  assert.equal(setStatus('---\nsmd: 1\ntags:\n  - a\n---\n', 'draft'), '---\nsmd: 1\ntags:\n  - a\nstatus: draft\n---\n');
  assert.equal(setStatus('---\n---\nBody\n', 'draft'), '---\nstatus: draft\n---\nBody\n', 'empty front matter');
  // A summary over several lines: the status goes after all of it.
  assert.equal(
    setStatus('---\nsummary: >\n  Two\n  lines.\ntitle: X\n---\n', 'review'),
    '---\nsummary: >\n  Two\n  lines.\nstatus: review\ntitle: X\n---\n',
  );
  assert.equal(setStatus('---\nsummary: a # comment\n---\n', 'draft'), '---\nsummary: a # comment\nstatus: draft\n---\n');
});

test('creates a minimal front matter when there is none', () => {
  assert.equal(setStatus('# Title\n\nBody\n', 'draft'), '---\nsmd: 1\nstatus: draft\n---\n\n# Title\n\nBody\n');
  assert.equal(setStatus('\n# Title\n', 'draft'), '---\nsmd: 1\nstatus: draft\n---\n\n# Title\n', 'no second blank line');
  assert.equal(setStatus('', 'review'), '---\nsmd: 1\nstatus: review\n---\n');
  assert.equal(setStatus('# T\r\n', 'draft'), '---\r\nsmd: 1\r\nstatus: draft\r\n---\r\n\r\n# T\r\n');
  assert.equal(setStatus('', 'draft', { eol: '\r\n' }), '---\r\nsmd: 1\r\nstatus: draft\r\n---\r\n', 'the editor\'s line ending for an empty document');
});

test('sets updated to today only when the key exists', () => {
  assert.equal(setStatus('---\nstatus: draft\nupdated: 2026-01-01\n---\n', 'review', { today: TODAY }), '---\nstatus: review\nupdated: 2026-09-30\n---\n');
  assert.equal(setStatus('---\nupdated: "2026-01-01" # auto\nstatus: draft\n---\n', 'review', { today: TODAY }), '---\nupdated: "2026-09-30" # auto\nstatus: review\n---\n');
  assert.equal(setStatus('---\nstatus: draft\n---\n', 'review', { today: TODAY }), '---\nstatus: review\n---\n', 'no updated key: none added');
  assert.equal(setStatus('---\nstatus: draft\nupdated: 2026-01-01\n---\n', 'review'), '---\nstatus: review\nupdated: 2026-01-01\n---\n', 'without today');
  // Inserted status right before the updated line: both edits apply.
  assert.equal(setStatus('---\ntitle: X\nupdated: 2026-01-01\n---\n', 'draft', { today: TODAY }), '---\ntitle: X\nstatus: draft\nupdated: 2026-09-30\n---\n');
  assert.equal(setStatus('# T\n', 'draft', { today: TODAY }), '---\nsmd: 1\nstatus: draft\n---\n\n# T\n', 'new front matter has no updated key');
});

test('no edits when the status is already set', () => {
  assert.deepEqual(setStatusEdits('---\nstatus: review\nupdated: 2026-01-01\n---\n', 'review', { today: TODAY }), { ok: true, edits: [] });
});

test('refuses front matter that cannot be read or edited safely', () => {
  assert.match(setStatus('---\nstatus: draft\n', 'review'), /^refused: .*never closed.*Fix the front matter first/);
  assert.match(setStatus('---\ntitle: [x\n---\n', 'review'), /^refused: Invalid YAML/);
  // A block value can't be replaced on one line: the result wouldn't parse back.
  assert.match(setStatus('---\nstatus: >\n  draft\n---\n', 'review'), /^refused: The status line could not be changed safely/);
});

test('value spans', () => {
  assert.deepEqual(valueSpan('status: draft'), { start: 8, end: 13, needsSpace: false });
  assert.deepEqual(valueSpan('status: "draft" # c'), { start: 9, end: 14, needsSpace: false });
  assert.deepEqual(valueSpan('status: a#b'), { start: 8, end: 11, needsSpace: false }, '# without a space before it is part of the value');
  assert.deepEqual(valueSpan('status:'), { start: 7, end: 7, needsSpace: true });
  assert.deepEqual(valueSpan('status: # only a comment'), { start: 8, end: 8, needsSpace: false });
});
