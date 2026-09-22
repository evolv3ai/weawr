// Recognising Claude Code's question dialog (AskUserQuestion) on a pane: the pane seen live on
// WTR-12, a permission prompt (not a dialog), a dialog without "Type something.", and no dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDialog, parseQuestionDialog } from '../dist/question-dialog.js';

export const DIALOG = [
  '● I will ask which tagline to use.',
  '',
  ' ☐ Tagline',
  'WTR-12: Which tagline should go on the line after the title in README.md?',
  '❯ 1. (A) Scratch repo',
  '     "A scratch repo for trying weawr."',
  '  2. (B) Trial issues',
  '     "Where weawr runs its trial issues."',
  '  3. Type something.',
  '────────────────',
  '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
].join('\n');

test('the dialog seen on WTR-12 parses: header, question, options with descriptions, the type option', () => {
  assert.deepEqual(parseQuestionDialog(DIALOG), {
    header: 'Tagline',
    question: 'WTR-12: Which tagline should go on the line after the title in README.md?',
    options: [
      { n: 1, label: '(A) Scratch repo', description: '"A scratch repo for trying weawr."' },
      { n: 2, label: '(B) Trial issues', description: '"Where weawr runs its trial issues."' },
    ],
    typeOption: 3,
  });
});

test('a question that wraps over several "│" lines, as seen on WTR-22, is joined without the border', () => {
  const pane = [
    ' ☐ Licence',
    '│ WTR-22: which Licence line should go at the end of README.md? (The issue text calls it a "Status" line, but both',
    '│ options are Licence lines. Whichever you pick goes on its own new line after the existing Status line.)',
    '❯ 1. (A) Licence: MIT.',
    '     Appends the line "Licence: MIT."',
    '  2. (B) All rights reserved',
    '     Appends the line "Licence: none yet, all rights reserved."',
    '  3. Type something.',
    '─'.repeat(120),
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  assert.deepEqual(parseQuestionDialog(pane), {
    header: 'Licence',
    question: 'WTR-22: which Licence line should go at the end of README.md? (The issue text calls it a "Status" line, but both '
      + 'options are Licence lines. Whichever you pick goes on its own new line after the existing Status line.)',
    options: [
      { n: 1, label: '(A) Licence: MIT.', description: 'Appends the line "Licence: MIT."' },
      { n: 2, label: '(B) All rights reserved', description: 'Appends the line "Licence: none yet, all rights reserved."' },
    ],
    typeOption: 3,
  });
});

test('a permission prompt is not a question dialog', () => {
  const pane = [
    ' Bash command',
    '   rm -rf dist',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don\'t ask again for rm commands in this project',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
  assert.equal(parseQuestionDialog(pane), null);
});

test('a dialog without "Type something." has no type option', () => {
  const pane = [
    ' ☐ Default',
    'Should the new flag default to on or off?',
    '❯ 1. On',
    '     Everyone gets it at once.',
    '  2. Off',
    '────────────────',
    '  3. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  assert.deepEqual(parseQuestionDialog(pane), {
    header: 'Default',
    question: 'Should the new flag default to on or off?',
    options: [{ n: 1, label: 'On', description: 'Everyone gets it at once.' }, { n: 2, label: 'Off', description: '' }],
    typeOption: null,
  });
});

test('a pane with no dialog on it is null, whatever is numbered on it', () => {
  assert.equal(parseQuestionDialog('● Done. The PR is open:\n  1. added the flag\n  2. docs\n\n> '), null);
  assert.equal(parseQuestionDialog(''), null);
  assert.equal(parseQuestionDialog(DIALOG.replace('Enter to select · ', '')), null);
});

test('the issue gets the question and the options, numbered as in the pane', () => {
  assert.equal(describeDialog(parseQuestionDialog(DIALOG)), [
    '> **Tagline** — WTR-12: Which tagline should go on the line after the title in README.md?',
    '',
    '1. **(A) Scratch repo** — "A scratch repo for trying weawr."',
    '2. **(B) Trial issues** — "Where weawr runs its trial issues."',
    '3. _or answer in your own words_',
  ].join('\n'));
});
