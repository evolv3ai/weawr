// Relaying a reply: while a run waits on a question, a person's comment on the issue is put to
// TypeSafe's Jev through a fake fetch and, when it answers the question (or the call fails), typed
// into the agent's pane and noted on the issue. weawr's own comments, comments from before the
// question and comments already looked at are left alone, restarts included; a run behind a dialog
// is never typed into; no config means no calls, and no key means one warning and no relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { teamPaths } from '../dist/paths.js';
import { TeamEngine } from '../dist/team.js';
import { SqliteStore, storePath } from '../dist/store/sqlite.js';
import { coordinator } from '../dist/comments.js';
import { RELAY_URL, normalizeRelay } from '../dist/relay.js';

const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));
const ASKED_AT = '2026-01-02T10:00:00.000Z';
const QUESTION = 'Should the new flag default to on or off?';
const ISSUE = { id: 'i7', identifier: 'GH-7', ref: 'GH-7', title: 'Add the flag', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'Agent Needs Input', type: 'started' } };
const YES = { answers: { answers: { noul: 0.93 } } };
const NO = { answers: { answers: { noul: 0.08 } } };
const at = (min) => new Date(Date.parse(ASKED_AT) + min * 60e3).toISOString();
const comment = (min, body, author = 'Ada') => ({ body, createdAt: at(min), author });

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function repo(relayReplies = { threshold: 0.5, model: 'jev-latest' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-relay-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({
    tracker: 'linear', ...(relayReplies ? { relayReplies } : {}),
    defaults: { worktree: 'none', onPickup: { comment: false, state: 'Agent Working' }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: true, notify: false, state: 'Agent Needs Input' }, onMerged: null },
    rules: [{ name: 'r', match: 'any:true' }],
  }));
  made.push(dir);
  return dir;
}
function fakeHerdr(dir, { waits = [], pane = QUESTION } = {}) {
  const h = {
    prompts: [],
    async agentGet(name) { return { agent: 'claude', name, agent_status: 'idle', cwd: dir, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }; },
    async prompt(name, text) { h.prompts.push({ name, text }); },
    async readAgent() { return pane; }, async notify() {}, async closeWorkspace() {},
    waitAgent() { return waits.length ? Promise.resolve(waits.shift()) : new Promise(() => {}); },
  };
  return h;
}
function fakeTracker(comments = []) {
  const t = {
    comments: [], moves: [], issue: { ...ISSUE, comments },
    async me() { return { id: 'me', name: 'me' }; },
    async openIssues() { return [t.issue]; },
    async issueByKey() { return t.issue; },
    async comment(id, body) { t.comments.push(body); }, async addLabel() {}, async removeLabel() {}, async assign() {},
    async setState(issue, state) { t.moves.push(state); },
  };
  return t;
}
/** A fetch that answers from a script, one entry per call: a body, an HTTP status, or an error to throw. */
function fakeFetch(script = []) {
  const f = async (url, init) => {
    f.calls.push({ url, init, body: JSON.parse(init.body) });
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return new Response('nope', { status: next });
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = [];
  return f;
}
/** A run that reported a question at ASKED_AT and is waiting on the answer. */
function waitingRun(dir, extra = {}) {
  const runDir = path.join(dir, '.weawr', 'state', 'runs', 'GH-7');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'issue.json'), JSON.stringify(ISSUE));
  return { rule: 'r', pass: 1, status: 'running', claimed: 'herdr', issueId: 'i7', issueKey: 'GH-7', title: ISSUE.title, startedAt: '2026-01-01T00:00:00Z', archiveDir: runDir, worktree: 'none', agentName: 'gh-7', workspaceId: 'w1', paneId: 'p1', workDir: dir, worktreePath: dir, dir: runDir, resultPath: path.join(runDir, 'result.json'), notified: { idle: true }, idleKind: 'asking', askedAt: ASKED_AT, askedTail: QUESTION, waitingOnPerson: 'Agent Needs Input', ...extra };
}
function engine(dir, { herdr, tracker, fetchImpl, env = { TYPESAFE_API_KEY: 'test-key' }, logs = [], run } = {}) {
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir));
  if (run) store.save({ runs: { 'GH-7': run }, nudges: {} });
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  return new TeamEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: (l) => logs.push(l), fetchImpl, env, clock: () => new Date(at(30)) });
}
function setup({ comments = [], script = [], run = {}, relayReplies, env, logs } = {}) {
  const dir = repo(relayReplies);
  const herdr = fakeHerdr(dir);
  const tracker = fakeTracker(comments);
  const fetchImpl = fakeFetch(script);
  const e = engine(dir, { herdr, tracker, fetchImpl, env, logs, run: waitingRun(dir, run) });
  return { dir, e, herdr, tracker, fetchImpl };
}

test('the config block: absent is off, defaults filled in, nonsense is refused', () => {
  assert.equal(normalizeRelay(undefined), null);
  assert.equal(normalizeRelay(null), null);
  assert.deepEqual(normalizeRelay({}), { threshold: 0.5, model: 'jev-latest' });
  assert.deepEqual(normalizeRelay({ threshold: 0.7, model: ' jev-2 ' }), { threshold: 0.7, model: 'jev-2' });
  assert.throws(() => normalizeRelay('on'), /"relayReplies" must be an object/);
  assert.throws(() => normalizeRelay({ threshold: 2 }), /"relayReplies.threshold"/);
  assert.throws(() => normalizeRelay({ model: '' }), /"relayReplies.model"/);
});

test('the idle report records when the agent asked and what its pane showed', async () => {
  const dir = repo();
  const herdr = fakeHerdr(dir, { waits: ['idle'] });
  const tracker = fakeTracker();
  const e = engine(dir, { herdr, tracker, fetchImpl: fakeFetch(), run: waitingRun(dir, { notified: {}, idleKind: undefined, askedAt: undefined, askedTail: undefined, waitingOnPerson: undefined }) });
  e.supervise('GH-7');
  await new Promise((r) => setTimeout(r, 50));
  const run = e.state.runs['GH-7'];
  assert.equal(run.notified.idle, true);
  assert.equal(run.askedAt, at(30));
  assert.equal(run.askedTail, QUESTION);
  assert.equal(tracker.comments.length, 1);
});

test('an answering comment is typed into the pane, and the issue says so', async () => {
  const { e, herdr, tracker, fetchImpl } = setup({ comments: [comment(5, 'Off by default, please.')], script: [YES] });
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, RELAY_URL);
  assert.equal(init.headers.authorization, 'Bearer test-key');
  assert.ok(init.signal, 'the call has a timeout');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state, { question: QUESTION, comment: 'Off by default, please.' });
  assert.equal(body.questions.answers.type, 'noul');
  assert.equal(herdr.prompts.length, 1);
  assert.equal(herdr.prompts[0].name, 'gh-7');
  assert.equal(herdr.prompts[0].text, 'Reply on GH-7 from Ada in the tracker:\n\nOff by default, please.\n\nCarry on with the task.');
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0], /↪️ \*\*Weawr Coordinator\*\* — relayed Ada's reply to the agent in workspace `w1`/);
  assert.equal(e.state.runs['GH-7'].relayedUpTo, at(5));
});

test('several answers go in one prompt, oldest first', async () => {
  const { e, herdr, tracker } = setup({ comments: [comment(9, 'Second: and log it.', 'Bo'), comment(4, 'First: off.')], script: [YES, YES] });
  await e.pollOnce();
  assert.equal(herdr.prompts.length, 1);
  assert.equal(herdr.prompts[0].text, 'Reply on GH-7 from Ada in the tracker:\n\nFirst: off.\n\nReply on GH-7 from Bo in the tracker:\n\nSecond: and log it.\n\nCarry on with the task.');
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0], /relayed Ada, Bo's reply/);
});

test('a comment that does not answer is not typed, and is not asked about again', async () => {
  const { e, herdr, tracker, fetchImpl } = setup({ comments: [comment(5, 'cc @someone for visibility')], script: [NO] });
  await e.pollOnce();
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(herdr.prompts.length, 0);
  assert.equal(tracker.comments.length, 0);
  assert.equal(e.state.runs['GH-7'].relayedUpTo, at(5));
});

test("weawr's own comments are ignored, even though the author is the same person", async () => {
  const { e, herdr, fetchImpl } = setup({ comments: [
    comment(2, coordinator('💬 the `r` agent for GH-7 stopped without a result and is asking a question.')),
    comment(3, '✅ **weawr** as `review` finished GH-7 with status `pr_open`.'),
  ] });
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(herdr.prompts.length, 0);
});

test('comments from before the question are ignored', async () => {
  const { e, herdr, fetchImpl } = setup({ comments: [comment(-60, 'An old remark.'), comment(0, 'Same instant as the question.')] });
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(herdr.prompts.length, 0);
});

test('a comment is never relayed twice, a restart included', async () => {
  const { dir, e, herdr, tracker, fetchImpl } = setup({ comments: [comment(5, 'Off.')], script: [YES] });
  await e.pollOnce();
  await e.pollOnce();
  assert.equal(herdr.prompts.length, 1);
  e.store.close?.();
  const again = engine(dir, { herdr, tracker, fetchImpl });
  assert.equal(again.state.runs['GH-7'].relayedUpTo, at(5), 'kept in the store');
  await again.pollOnce();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(herdr.prompts.length, 1);
  assert.equal(tracker.comments.length, 1);
});

test('a run behind a dialog is never typed into', async () => {
  const { e, herdr, fetchImpl } = setup({ comments: [comment(5, 'Off.')], run: { notified: { idle: true, blocked: true } } });
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(herdr.prompts.length, 0);
});

test('a stop the idle check did not call a question is not relayed to', async () => {
  const { e, herdr, fetchImpl } = setup({ comments: [comment(5, 'Off.')], run: { idleKind: 'errored' } });
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(herdr.prompts.length, 0);
});

test('without the idle check, a reported stop is relayed to', async () => {
  const { e, herdr } = setup({ comments: [comment(5, 'Off.')], script: [YES], run: { idleKind: null } });
  await e.pollOnce();
  assert.equal(herdr.prompts.length, 1);
});

for (const [what, answer] of [['an HTTP error', 503], ['a thrown error', new Error('ECONNRESET')], ['a body without a score', { answers: {} }]]) {
  test(`a failed call (${what}) relays the comment anyway`, async () => {
    const logs = [];
    const { e, herdr, tracker } = setup({ comments: [comment(5, 'Off.')], script: [answer], logs });
    await e.pollOnce();
    assert.equal(herdr.prompts.length, 1);
    assert.equal(tracker.comments.length, 1);
    assert.ok(logs.some((l) => /reply check failed/.test(l)));
  });
}

test('a prompt that does not reach the agent is tried again on the next poll', async () => {
  const { e, herdr, tracker, fetchImpl } = setup({ comments: [comment(3, 'unrelated'), comment(5, 'Off.')], script: [NO, YES, YES] });
  let fail = true;
  const prompt = herdr.prompt;
  herdr.prompt = async (...a) => { if (fail) { fail = false; throw new Error('agent_prompt_stalled'); } return prompt(...a); };
  await e.pollOnce();
  assert.equal(e.state.runs['GH-7'].relayedUpTo, at(3), 'the non-answer is settled, the answer is not');
  assert.equal(tracker.comments.length, 0);
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(herdr.prompts.length, 1);
  assert.equal(e.state.runs['GH-7'].relayedUpTo, at(5));
});

test('no relayReplies config: no calls, nothing typed', async () => {
  const { e, herdr, fetchImpl } = setup({ comments: [comment(5, 'Off.')], relayReplies: null });
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(herdr.prompts.length, 0);
});

test('no key: one warning, however many polls, and nothing relayed', async () => {
  const logs = [];
  const { e, herdr, fetchImpl } = setup({ comments: [comment(5, 'Off.')], env: {}, logs });
  await e.pollOnce();
  await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(herdr.prompts.length, 0);
  assert.equal(logs.filter((l) => /reply relay is configured but TYPESAFE_API_KEY is not set/.test(l)).length, 1);
});
