// A person being waited on is visible on the tracker: a dialog, a question in chat or a
// needs_human result moves the issue to the policy's `state`, and work resuming moves it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TeamEngine, SqliteStore, teamPaths, loadConfig, storePath } from '@weawr/engine';

const PROMPTS = fileURLToPath(new URL('../../../packages/recipes/prompts', import.meta.url));
const ISSUE = { id: 'i7', identifier: 'GH-7', ref: 'GH-7', title: 'Fix the thing', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'Agent Todo', type: 'unstarted' } };
const WAITING = 'Agent Needs Input';

function repo(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-waiting-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify(config));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const CONFIG = (waiting = WAITING) => ({ tracker: 'linear', defaults: { worktree: 'none', onPickup: { comment: false, state: 'Agent Working' }, onDone: { comment: false, state: 'Agent Review', notify: false }, onBlocked: { comment: false, notify: false, ...(waiting ? { state: waiting } : {}) }, onIdle: { comment: false, notify: false, ...(waiting ? { state: waiting } : {}) }, onMerged: null }, rules: [{ name: 'r', match: 'any:true' }] });

/** A herdr whose `agent wait` answers are scripted, one per call; when they run out it parks, as a live agent would. */
function scriptedHerdr(dir, answers) {
  const queue = [...answers];
  return {
    async agentGet(name) { return { agent: 'claude', name, agent_status: 'idle', cwd: dir, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }; },
    async prompt() {}, async readAgent() { return ''; }, async notify() {}, async closeWorkspace() {},
    waitAgent() { return queue.length ? Promise.resolve(queue.shift()) : new Promise(() => {}); },
  };
}
function fakeTracker() {
  const t = {
    moves: [],
    async me() { return { id: 'me', name: 'me' }; },
    async issueByKey() { return { ...ISSUE }; },
    async comment() {}, async addLabel() {}, async removeLabel() {}, async assign() {},
    async setState(issue, state) { t.moves.push(state); },
  };
  return t;
}
function runningRun(dir) {
  const runDir = path.join(dir, '.weawr', 'state', 'runs', 'GH-7');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'issue.json'), JSON.stringify(ISSUE));
  return { rule: 'r', pass: 1, status: 'running', claimed: 'herdr', issueId: 'i7', issueKey: 'GH-7', title: ISSUE.title, startedAt: '2026-01-01T00:00:00Z', archiveDir: runDir, worktree: 'none', agentName: 'gh-7', notified: {}, workspaceId: 'w1', paneId: 'p1', workDir: dir, worktreePath: dir, dir: runDir, resultPath: path.join(runDir, 'result.json') };
}
function engine(dir, { herdr, tracker }) {
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir));
  store.save({ runs: { 'GH-7': runningRun(dir) }, nudges: {} });
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  return new TeamEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: () => {} });
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test('a dialog moves the issue to the waiting state, and the agent working again moves it back', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker();
  const e = engine(dir, { herdr: scriptedHerdr(dir, ['blocked', 'working']), tracker });
  e.supervise('GH-7');
  await settle();
  assert.deepEqual(tracker.moves, [WAITING, 'Agent Working']);
  assert.equal(e.state.runs['GH-7'].waitingOnPerson, null);
});

test('a question in chat moves the issue to the waiting state until the agent works again', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker();
  const e = engine(dir, { herdr: scriptedHerdr(dir, ['idle', 'working']), tracker });
  e.supervise('GH-7');
  await settle();
  assert.deepEqual(tracker.moves, [WAITING, 'Agent Working']);
});

test('an agent still asking after its dialog keeps the issue waiting, moved once', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker();
  // dialog → answered but idle (a question) → the loop comes round and finds it idle → parks
  const e = engine(dir, { herdr: scriptedHerdr(dir, ['blocked', 'idle', 'idle']), tracker });
  e.supervise('GH-7');
  await settle();
  assert.deepEqual(tracker.moves, [WAITING]);
  assert.equal(e.state.runs['GH-7'].waitingOnPerson, WAITING, 'the wait survives a restart in the saved run');
});

test('a needs_human result leaves the issue waiting; pr_open still goes to review', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker();
  const e = engine(dir, { herdr: scriptedHerdr(dir, []), tracker });
  await e.finalize('GH-7', { status: 'needs_human', summary: 'which format?' }, e.cfg.rules[0]);
  assert.deepEqual(tracker.moves, [WAITING]);

  const dir2 = repo(CONFIG());
  const tracker2 = fakeTracker();
  const e2 = engine(dir2, { herdr: scriptedHerdr(dir2, []), tracker: tracker2 });
  await e2.finalize('GH-7', { status: 'pr_open', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' }, e2.cfg.rules[0]);
  assert.deepEqual(tracker2.moves, ['Agent Review']);
});

test('without a state in onBlocked/onIdle nothing moves: the old behaviour', async () => {
  const dir = repo(CONFIG(null));
  const tracker = fakeTracker();
  const e = engine(dir, { herdr: scriptedHerdr(dir, ['blocked', 'working', 'idle', 'working']), tracker });
  e.supervise('GH-7');
  await settle();
  await e.finalize('GH-7', { status: 'needs_human', summary: 'q' }, e.cfg.rules[0]);
  assert.deepEqual(tracker.moves, []);
});
