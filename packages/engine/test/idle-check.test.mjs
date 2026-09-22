// The idle check: an agent that stops without a result is classified by TypeSafe's Jev, through a
// fake fetch, from its pane's tail. A question is reported as one; an agent that seems finished is
// asked, once per turn, to write its result instead of anyone being pinged; an error is reported as
// an error. Anything else, a failed call, no config or no key: the report it always made.
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
import { teamView, indexSnapshot } from '../dist/projection.js';
import { IDLE_CHECK_URL, normalizeIdleCheck } from '../dist/idle-check.js';

const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));
const ISSUE = { id: 'i7', identifier: 'GH-7', ref: 'GH-7', title: 'Fix the thing', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'Agent Todo', type: 'unstarted' } };
const WAITING = 'Agent Needs Input';
// 60 lines with blanks between them: the check sees the last 40 that are not blank.
const PANE = Array.from({ length: 60 }, (_, i) => `line ${i + 1}\n`).join('\n');
const ANSWER = (choice) => ({ answers: { idle: { choice, confidence: 0.9 } } });

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function repo(idleCheck = { model: 'jev-latest' }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-idle-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({
    tracker: 'linear', ...(idleCheck ? { idleCheck } : {}),
    defaults: { worktree: 'none', onPickup: { comment: false, state: 'Agent Working' }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: true, notify: false, state: WAITING }, onMerged: null },
    rules: [{ name: 'r', match: 'any:true' }],
  }));
  made.push(dir);
  return dir;
}

/** A herdr whose `agent wait` answers are scripted, one per call; when they run out it parks, as a live agent would. */
function scriptedHerdr(dir, answers) {
  const queue = [...answers];
  const h = {
    prompts: [],
    async agentGet(name) { return { agent: 'claude', name, agent_status: 'idle', cwd: dir, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }; },
    async prompt(name, text) { h.prompts.push(text); },
    async readAgent() { return PANE; }, async notify() {}, async closeWorkspace() {},
    waitAgent() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(() => {}); },
  };
  return h;
}
function fakeTracker() {
  const t = {
    moves: [], comments: [],
    async me() { return { id: 'me', name: 'me' }; },
    async issueByKey() { return { ...ISSUE }; },
    async comment(id, body) { t.comments.push(body); }, async addLabel() {}, async removeLabel() {}, async assign() {},
    async setState(issue, state) { t.moves.push(state); },
  };
  return t;
}
/** A fetch that answers from a script, one entry per call: a body, an HTTP status, or an error to throw. */
function fakeFetch(script) {
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
function runningRun(dir) {
  const runDir = path.join(dir, '.weawr', 'state', 'runs', 'GH-7');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'issue.json'), JSON.stringify(ISSUE));
  return { rule: 'r', pass: 1, status: 'running', claimed: 'herdr', issueId: 'i7', issueKey: 'GH-7', title: ISSUE.title, startedAt: '2026-01-01T00:00:00Z', archiveDir: runDir, worktree: 'none', agentName: 'gh-7', notified: {}, workspaceId: 'w1', paneId: 'p1', workDir: dir, worktreePath: dir, dir: runDir, resultPath: path.join(runDir, 'result.json') };
}
function engine(dir, { herdr, tracker, fetchImpl, env = { TYPESAFE_API_KEY: 'test-key' }, logs = [] }) {
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir));
  store.save({ runs: { 'GH-7': runningRun(dir) }, nudges: {} });
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  return new TeamEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: (l) => logs.push(l), fetchImpl, env });
}
const settle = () => new Promise((r) => setTimeout(r, 50));

async function supervised(answers, { script = [], idleCheck, env, logs } = {}) {
  const dir = repo(idleCheck);
  const tracker = fakeTracker();
  const herdr = scriptedHerdr(dir, answers);
  const fetchImpl = fakeFetch(script);
  const e = engine(dir, { herdr, tracker, fetchImpl, env, logs });
  e.supervise('GH-7');
  await settle();
  return { e, tracker, herdr, fetchImpl, run: e.state.runs['GH-7'] };
}

test('the config block: absent is off, a model defaults to jev-latest, nonsense is refused', () => {
  assert.equal(normalizeIdleCheck(undefined), null);
  assert.equal(normalizeIdleCheck(null), null);
  assert.deepEqual(normalizeIdleCheck({}), { model: 'jev-latest' });
  assert.deepEqual(normalizeIdleCheck({ model: ' jev-2 ' }), { model: 'jev-2' });
  assert.throws(() => normalizeIdleCheck('on'), /"idleCheck" must be an object/);
  assert.throws(() => normalizeIdleCheck({ model: '' }), /"idleCheck.model"/);
});

test('asking: reported as a question, not "probably", and the issue waits until it works again', async () => {
  const { tracker, fetchImpl, run } = await supervised(['idle', 'working'], { script: [ANSWER('asking')] });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, IDLE_CHECK_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer test-key');
  assert.ok(init.signal, 'the call has a timeout');
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.state.issue_title, ISSUE.title);
  const lines = body.state.pane_tail.split('\n');
  assert.equal(lines.length, 40); assert.equal(lines[0], 'line 21'); assert.equal(lines.at(-1), 'line 60');
  assert.equal(body.questions.idle.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.idle.criteria), ['asking', 'finished', 'errored', 'other']);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0], /stopped without a result and is asking a question/);
  assert.doesNotMatch(tracker.comments[0], /probably/);
  assert.deepEqual(tracker.moves, [WAITING, 'Agent Working']);
  assert.equal(run.idleKind, null, 'cleared once it works again');
});

test('finished: the agent is asked for its result once per turn, nobody is pinged, and a second idle is a question', async () => {
  const { tracker, herdr, fetchImpl, run } = await supervised(['idle', 'idle'], { script: [ANSWER('finished'), ANSWER('finished')] });
  assert.equal(herdr.prompts.length, 1);
  assert.match(herdr.prompts[0], /have not written your result file at .*result\.json/);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(tracker.comments.length, 1, 'only the second stop is reported');
  assert.match(tracker.comments[0], /is asking a question/);
  assert.deepEqual(tracker.moves, [WAITING]);
  assert.equal(run.idleKind, 'asking');
  assert.equal(run.notified.resultAsked, true);
});

test('finished again after a person answered, in the same turn: still only one reminder', async () => {
  // reminded → idle again (a question) → a person answers, it works → idle again, "finished"
  const { tracker, herdr } = await supervised(['idle', 'idle', 'working', 'idle'], { script: [ANSWER('finished'), ANSWER('finished'), ANSWER('finished')] });
  assert.equal(herdr.prompts.length, 1);
  assert.equal(tracker.comments.length, 2);
  for (const c of tracker.comments) assert.match(c, /is asking a question/);
});

test('errored: reported as stopped on an error, with the tail, and the issue waits', async () => {
  const { tracker, herdr, run } = await supervised(['idle'], { script: [ANSWER('errored')] });
  assert.equal(herdr.prompts.length, 0);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0], /stopped on an error/);
  assert.match(tracker.comments[0], /line 60/);
  assert.doesNotMatch(tracker.comments[0], /asking a question/);
  assert.deepEqual(tracker.moves, [WAITING]);
  assert.equal(run.idleKind, 'errored');
});

test('other: exactly the old report', async () => {
  const { tracker, run } = await supervised(['idle'], { script: [ANSWER('other')] });
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0], /stopped without a result and is probably asking a question/);
  assert.deepEqual(tracker.moves, [WAITING]);
  assert.equal(run.idleKind, 'other');
});

test('a failed call gives the old report: HTTP error, network error, timeout, bad body', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  for (const answer of [500, new TypeError('fetch failed'), timeout, { answers: {} }, ANSWER('bogus')]) {
    const logs = [];
    const { tracker, fetchImpl, run } = await supervised(['idle'], { script: [answer], logs });
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(tracker.comments.length, 1);
    assert.match(tracker.comments[0], /stopped without a result and is probably asking a question/);
    assert.deepEqual(tracker.moves, [WAITING]);
    assert.equal(run.idleKind, null);
    assert.ok(logs.some((l) => /idle check failed/.test(l)), `logged for ${answer?.name || answer}`);
  }
});

test('no idleCheck config: no call at all, the old report', async () => {
  const { tracker, fetchImpl } = await supervised(['idle'], { idleCheck: null });
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(tracker.comments[0], /is probably asking a question/);
});

test('configured without a key: warned once, no call, the old report', async () => {
  const logs = [];
  const { tracker, fetchImpl } = await supervised(['idle', 'working', 'idle'], { env: {}, logs });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(logs.filter((l) => /TYPESAFE_API_KEY is not set/.test(l)).length, 1);
  assert.equal(tracker.comments.length, 2);
  for (const c of tracker.comments) assert.match(c, /is probably asking a question/);
});

test('the console alert says what the idle check said', () => {
  const run = (idleKind) => ({ 'GH-7@impl': { rule: 'r', role: 'impl', status: 'running', issueKey: 'GH-7', title: 'x', agentName: 'gh-7-impl', workspaceId: 'w1', startedAt: '2026-01-01T00:00:00Z', idleKind } });
  const index = indexSnapshot({ agents: [{ name: 'gh-7-impl', agent_status: 'idle', workspace_id: 'w1' }] });
  const text = (kind) => teamView({ id: 'x', repo: '/r', config: {}, state: { runs: run(kind) }, index, seen: null, now: Date.parse('2026-01-01T01:00:00Z') }).alerts.find((a) => a.kind === 'question')?.text;
  assert.match(text(undefined), /probably asking a question/);
  assert.match(text('other'), /probably asking a question/);
  assert.match(text('asking'), /is asking a question/);
  assert.doesNotMatch(text('asking'), /probably/);
  assert.match(text('errored'), /on an error/);
  assert.match(text('finished'), /Seems finished/);
});
