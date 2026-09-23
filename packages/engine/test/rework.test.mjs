// `weawr rework <KEY>`: the steps that send a PR back to its agent, in order, against a fake
// tracker and a fake `gh`. Each case is one of the ways the by-hand version went wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueStateOf, rework } from '../dist/rework.js';

const PR = 'https://github.com/evolv3ai/weawr/pull/12';
const PICKUP = '**weawr** picked this up';

function fakeTracker({ comments = [], labels = ['pilot', 'herdr'], state = { name: 'In Review', type: 'started' } } = {}, calls = []) {
  const issue = { id: 'uuid-7', identifier: 'WTR-7', labels, state, comments };
  return {
    calls,
    async issueByKey(key) { calls.push(`issueByKey ${key}`); return key === 'WTR-7' ? issue : null; },
    async comment(id, body) { calls.push(`comment ${id} ${body}`); },
    async deleteComment(id) { calls.push(`deleteComment ${id}`); },
    async removeLabel(id, name) { calls.push(`removeLabel ${id} ${name}`); },
    async setState(i, name) { calls.push(`setState ${i.id} ${name}`); return { name, type: 'unstarted' }; },
  };
}

function fakeGh(prState = 'OPEN', calls = []) {
  return async (args) => { calls.push(`gh ${args.join(' ')}`); return args[1] === 'view' ? JSON.stringify({ state: prState }) : ''; };
}

/** Runs rework with fakes; everything it did lands in one ordered `calls` list. */
async function go({ key = 'WTR-7', note = null, runs, rules = [{ name: 'pilot', match: 'label:pilot state:Todo', claimLabel: 'herdr' }], issue = {}, prState = 'OPEN', tracker } = {}) {
  const calls = [];
  const lines = [];
  runs ??= { 'WTR-7': { rule: 'pilot', role: null, status: 'awaiting_merge', prUrl: PR, claimed: 'herdr' } };
  const forgotten = [];
  await rework({
    key, note, runs, rules,
    tracker: tracker ?? fakeTracker(issue, calls),
    gh: fakeGh(prState, calls),
    forget: async () => { const gone = Object.keys(runs).filter((k) => k === key || k.startsWith(`${key}@`)); calls.push(`forget ${gone.join(',')}`); forgotten.push(...gone); return gone; },
    print: (l) => lines.push(l),
  });
  return { calls, lines, forgotten };
}

test('the steps run in order: note, close the open PR, forget, delete the pickup, drop the label, back to the queue', async () => {
  const comments = [
    { id: 'c1', body: `${PICKUP} — agent started`, author: 'weawr' },
    { id: 'c2', body: 'please also fix the typo', author: 'owner' },
    { id: 'c3', body: '**weawr** finished: PR open', author: 'weawr' },
  ];
  const { calls, lines } = await go({ note: 'test', issue: { comments } });
  assert.deepEqual(calls, [
    'issueByKey WTR-7',
    'comment uuid-7 test',
    `gh pr view ${PR} --json state`, `gh pr close ${PR}`,
    'forget WTR-7',
    'deleteComment c1',
    'removeLabel uuid-7 herdr',
    'setState uuid-7 Todo',
  ]);
  assert.equal(lines.length, 6, 'one line per step');
  assert.match(lines[1], /closed .*pull\/12 \(the branch is kept\)/);
  assert.match(lines[5], /moved WTR-7 to Todo/);
});

test('an already-closed PR is not closed again, and no --note posts nothing', async () => {
  const { calls, lines } = await go({ prState: 'CLOSED' });
  assert.ok(!calls.some((c) => c.startsWith('comment')), 'nothing posted');
  assert.ok(!calls.includes(`gh pr close ${PR}`));
  assert.match(lines[0], /no --note/);
  assert.match(lines[1], /already closed/);
});

test('with no pickup comment on the issue, nothing is deleted and it says so', async () => {
  const { calls, lines } = await go({ issue: { comments: [{ id: 'c2', body: 'a person talking', author: 'x' }] } });
  assert.ok(!calls.some((c) => c.startsWith('deleteComment')));
  assert.match(lines[3], /no weawr pickup comment on WTR-7/);
});

test('roles: an issue key sends back every role — each claim label, every pickup comment', async () => {
  const runs = {
    'WTR-7@impl': { rule: 'impl', role: 'impl', status: 'awaiting_merge', prUrl: PR, claimed: 'herdr:impl' },
    'WTR-7@review': { rule: 'review', role: 'review', status: 'done', claimed: 'herdr:review' },
  };
  const rules = [{ name: 'impl', role: 'impl', match: 'label:pilot state:"Todo"', claimLabel: 'herdr' }, { name: 'review', role: 'review', match: 'label:ready-for-review', claimLabel: 'herdr' }];
  const comments = [{ id: 'a', body: `${PICKUP} as \`impl\``, author: 'w' }, { id: 'b', body: `${PICKUP} as \`review\``, author: 'w' }];
  const { calls } = await go({ runs, rules, issue: { comments, labels: ['pilot', 'herdr:impl', 'herdr:review'] } });
  assert.deepEqual(calls.filter((c) => /^(deleteComment|removeLabel|setState|forget)/.test(c)), [
    'forget WTR-7@impl,WTR-7@review', 'deleteComment a', 'deleteComment b',
    'removeLabel uuid-7 herdr:impl', 'removeLabel uuid-7 herdr:review', 'setState uuid-7 Todo',
  ]);
});

test('roles: a run key sends back just that role, and the label comes from its rule when the run did not record one', async () => {
  const runs = { 'WTR-7@impl': { rule: 'impl', role: 'impl', status: 'awaiting_merge', prUrl: PR }, 'WTR-7@review': { rule: 'review', role: 'review', status: 'done' } };
  const rules = [{ name: 'impl', role: 'impl', match: 'state:Todo', claimLabel: 'herdr' }, { name: 'review', role: 'review', match: 'any:true', claimLabel: 'herdr' }];
  const comments = [{ id: 'a', body: `${PICKUP} as \`impl\``, author: 'w' }, { id: 'b', body: `${PICKUP} as \`review\``, author: 'w' }];
  const { calls } = await go({ key: 'WTR-7@impl', runs, rules, issue: { comments, labels: ['herdr:impl', 'herdr:review'] } });
  assert.deepEqual(calls.filter((c) => /^(deleteComment|removeLabel|forget)/.test(c)), ['forget WTR-7@impl', 'deleteComment a', 'removeLabel uuid-7 herdr:impl']);
});

test('a rule with no state: clause leaves the state alone and says so', async () => {
  const { calls, lines } = await go({ rules: [{ name: 'pilot', match: 'label:pilot', claimLabel: 'herdr' }] });
  assert.ok(!calls.some((c) => c.startsWith('setState')));
  assert.match(lines[5], /rule "pilot" names no state: in its match, so WTR-7 stays in In Review/);
});

test('an unknown key is refused before anything is touched', async () => {
  const calls = [];
  await assert.rejects(go({ key: 'WTR-99', tracker: fakeTracker({}, calls) }), /no run recorded for WTR-99/);
  assert.deepEqual(calls, []);
});

test('the first failing step stops the rest, and the message names it', async () => {
  const calls = [];
  const tracker = { ...fakeTracker({ comments: [{ id: 'c1', body: PICKUP, author: 'w' }] }, calls), async deleteComment() { throw new Error('Linear HTTP 403: forbidden'); } };
  await assert.rejects(go({ tracker }), /step 4 \(delete the pickup comments\) failed: Linear HTTP 403: forbidden — the steps before it are done/);
  assert.ok(!calls.some((c) => /^(removeLabel|setState)/.test(c)), 'nothing after the failure ran');
});

test('queueStateOf reads the state a rule asks for, not one it excludes', () => {
  assert.equal(queueStateOf('label:pilot state:"Todo"'), 'Todo');
  assert.equal(queueStateOf('status:Backlog or state:Todo'), 'Backlog');
  assert.equal(queueStateOf('label:pilot not state:Done'), null);
  assert.equal(queueStateOf('state!=Done'), null);
  assert.equal(queueStateOf('state:To*'), null);
  assert.equal(queueStateOf('label:pilot'), null);
  assert.equal(queueStateOf(undefined), null);
});
