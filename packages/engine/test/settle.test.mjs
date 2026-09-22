// Settling a run (WTR-17): a run whose issue is no longer open — completed or canceled — or whose
// pull request was closed is marked settled in state.json, so the console stops asking a person
// about it. The open list only reaches back `lookbackDays`, so an issue missing from it is looked
// up before anything is concluded; one still open is left alone, and a live run is let finish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { teamPaths } from '../dist/paths.js';
import { TeamEngine, ISSUE_POLL_MS } from '../dist/team.js';
import { SqliteStore, storePath } from '../dist/store/sqlite.js';

const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));
const NOW = Date.parse('2026-09-21T12:00:00.000Z');

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-settle-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({
    tracker: 'linear',
    defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: false }, onMerged: null },
    rules: [{ name: 'r', match: 'label:never' }],
  }));
  made.push(dir);
  return dir;
}
const issue = (identifier, type) => ({ id: identifier, identifier, title: identifier, labels: [], comments: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', state: { name: type, type } });
function fakeTracker({ open = [], states = {} } = {}) {
  const t = {
    lookups: [],
    async me() { return { id: 'me', name: 'me' }; },
    async openIssues() { return open.map((k) => issue(k, 'started')); },
    async issueByKey(k) { t.lookups.push(k); return k in states ? issue(k, states[k]) : null; },
    async comment() {}, async addLabel() {}, async removeLabel() {}, async assign() {}, async setState() {},
  };
  return t;
}
const herdr = { async agentGet() { return null; }, async notify() {}, async closeWorkspace() {}, async prompt() {}, waitAgent() { return new Promise(() => {}); } };
const run = (key, extra = {}) => ({ rule: 'r', pass: 1, status: 'done', issueKey: key, title: key, startedAt: '2026-09-21T09:00:00Z', finishedAt: '2026-09-21T10:00:00Z', agentName: key.toLowerCase(), worktree: 'none', notified: {}, result: { status: 'needs_human', summary: 'Which way?' }, ...extra });
function engine(runs, { tracker, fetchImpl = async () => { throw new Error('no network in tests'); }, clock = () => new Date(NOW) } = {}) {
  const dir = repo();
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir));
  store.save({ runs, nudges: {} });
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  return new TeamEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: () => {}, fetchImpl, env: {}, clock });
}

test('a poll that no longer sees a run\'s issue, and finds it canceled or completed, marks the run settled', async () => {
  const tracker = fakeTracker({ open: ['WTR-3'], states: { 'WTR-1': 'canceled', 'WTR-2': 'completed', 'WTR-4': 'started' } });
  const e = engine({ 'WTR-1': run('WTR-1'), 'WTR-2': run('WTR-2'), 'WTR-3': run('WTR-3'), 'WTR-4': run('WTR-4'), 'WTR-5': run('WTR-5', { status: 'running' }) }, { tracker });
  await e.pollOnce();
  const s = e.state.runs;
  assert.deepEqual(s['WTR-1'].settled, { why: 'issue_canceled', at: new Date(NOW).toISOString() });
  assert.equal(s['WTR-2'].settled.why, 'issue_completed');
  assert.equal(s['WTR-3'].settled, undefined, 'still in the open list');
  assert.equal(s['WTR-4'].settled, undefined, 'missing from the list only because it is older than the lookback: still open');
  assert.equal(s['WTR-5'].settled, undefined, 'a live run is let finish first');
  assert.deepEqual(tracker.lookups.sort(), ['WTR-1', 'WTR-2', 'WTR-4'], 'the list is trusted for what it has; a live run is not asked about');
  // the store has it, so a restart remembers
  const store = SqliteStore.open(storePath(e.paths.stateDir));
  assert.equal(store.load().runs['WTR-1'].settled.why, 'issue_canceled');
});

test('an issue still open is not looked up again until ISSUE_POLL_MS has passed', async () => {
  let now = NOW;
  const tracker = fakeTracker({ states: { 'WTR-4': 'started' } });
  const e = engine({ 'WTR-4': run('WTR-4') }, { tracker, clock: () => new Date(now) });
  await e.pollOnce(); await e.pollOnce();
  assert.deepEqual(tracker.lookups, ['WTR-4']);
  now += ISSUE_POLL_MS;
  tracker.lookups.length = 0;
  await e.pollOnce();
  assert.deepEqual(tracker.lookups, ['WTR-4']);
});

test('a pull request closed without merging settles its run', async () => {
  const prUrl = 'https://github.com/o/r/pull/2';
  const fetchImpl = async () => new Response(JSON.stringify({ state: 'closed', merged_at: null, head: { sha: 'abc' }, base: { ref: 'main' } }), { status: 200 });
  const tracker = fakeTracker({ open: ['WTR-2'] });
  const e = engine({ 'WTR-2': run('WTR-2', { status: 'awaiting_merge', prUrl, result: { status: 'pr_open', prUrl } }) }, { tracker, fetchImpl });
  await e.pollOnce();
  assert.equal(e.state.runs['WTR-2'].status, 'done');
  assert.equal(e.state.runs['WTR-2'].settled.why, 'pr_closed');
});
