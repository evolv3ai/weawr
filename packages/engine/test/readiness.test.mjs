// The readiness check before a pickup: TypeSafe's Jev is asked whether an issue says what to change,
// through a fake fetch. A ready issue is picked up as before; one that is not gets a comment, its
// onBlocked state and no pickup, and is not asked about again until it is edited. Any failure of
// the call picks the issue up anyway, and a config without "readiness" never calls out at all.
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
import { READINESS_URL, normalizeReadiness } from '../dist/readiness.js';
import { validate, teamSnapshotSchema } from '@weawr/protocol';

const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));
const ISSUE = { id: 'i9', identifier: 'WTR-9', ref: 'WTR-9', title: 'Rename the thing to the new name', description: '', url: 'https://example.test/9', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'Todo', type: 'unstarted' } };
const READY = { answers: { self_contained: { noul: 0.88 }, missing: { choice: 'acceptance', confidence: 0.6 } } };
const VAGUE = { answers: { self_contained: { noul: 0.04 }, missing: { choice: 'target_value', confidence: 0.9 } } };

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function repo(config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-readiness-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'README.md'), '# thing\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  made.push(dir);
  return dir;
}
const CONFIG = (readiness = { threshold: 0.5, model: 'jev-latest' }) => ({
  tracker: 'linear', ...(readiness ? { readiness } : {}),
  defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: false, notify: false }, onBlocked: { comment: true, notify: true, state: 'Needs Info' }, onIdle: { comment: false, notify: false } },
  rules: [{ name: 'r', match: 'any:true' }],
});

function fakeTracker(issue) {
  const t = {
    issue: { ...issue }, comments: [], moves: [],
    async me() { return { id: 'me', name: 'me' }; },
    async openIssues() { return [{ ...t.issue }]; },
    async issueByKey() { return { ...t.issue }; },
    // Writing on an issue changes its updatedAt, as it does on Linear.
    async comment(id, body) { t.comments.push(body); t.issue.updatedAt = '2026-01-01T00:05:00Z'; },
    async setState(i, state) { t.moves.push(state); t.issue.updatedAt = '2026-01-01T00:06:00Z'; },
    async addLabel() {}, async removeLabel() {}, async assign() {},
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
function engine(dir, { tracker, fetchImpl, env = { TYPESAFE_API_KEY: 'test-key' }, store, dry = false, logs = [] }) {
  const paths = teamPaths(dir);
  const cfg = loadConfig({ paths, promptsRoot: PROMPTS });
  const notes = [];
  const herdr = { async notify(title, body) { notes.push(body); } };
  const e = new TeamEngine({ cfg, tracker, herdr, paths, promptsRoot: PROMPTS, store: store ?? SqliteStore.open(storePath(paths.stateDir)), ids: { hostId: 'h', teamId: 'f' }, log: (l) => logs.push(l), fetchImpl, env, dry });
  e.picked = [];
  e.pickUp = async (issue, rule) => { e.picked.push(issue.identifier); };
  e.notes = notes;
  return e;
}

test('a ready issue is asked about once and picked up as before', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([READY]);
  const e = engine(dir, { tracker, fetchImpl });
  const r = await e.pollOnce();
  assert.deepEqual(r.picked, ['WTR-9']);
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init, body } = fetchImpl.calls[0];
  assert.equal(url, READINESS_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer test-key');
  assert.ok(init.signal, 'the call has a timeout');
  assert.equal(body.model, 'jev-latest');
  assert.deepEqual(body.state.issue, { title: ISSUE.title, description: '' });
  assert.deepEqual(body.state.repo_files, ['README.md']);
  assert.equal(body.questions.self_contained.type, 'noul');
  assert.equal(body.questions.missing.type, 'choice');
  assert.deepEqual(tracker.comments, []);
  assert.deepEqual(tracker.moves, []);
});

test('a vague issue gets one comment and its onBlocked state, and no pickup', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([VAGUE]);
  const e = engine(dir, { tracker, fetchImpl });
  const r = await e.pollOnce();
  assert.deepEqual(r.picked, []);
  assert.deepEqual(e.picked, []);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0], /did not start an agent on WTR-9/);
  assert.match(tracker.comments[0], /a specific value, name or format it refers to but does not give/);
  assert.match(tracker.comments[0], /Edit the issue .*then move it back to the queue/);
  assert.deepEqual(tracker.moves, ['Needs Info']);
  assert.equal(e.notes.length, 1, 'notified under onBlocked.notify');
});

test('a held issue is a "held" alert in the snapshot until it is edited and picked up', async () => {
  // WTR-18: the console showed nothing for an issue the gate held; only the Linear comment did.
  const dir = repo(CONFIG());
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([VAGUE, READY]);
  const e = engine(dir, { tracker, fetchImpl });
  e.herdr.run = async () => { throw new Error('no herdr here'); };
  e.enricher = { view: () => ({ issues: {}, prs: {}, branches: {} }), refresh() {}, sources: {}, lastAskedAt: null, lastError: null };
  await e.pollOnce();
  const snap = await e.snapshot();
  assert.ok(validate(teamSnapshotSchema, snap).ok, 'a held alert, with no run, is a valid snapshot');
  const held = snap.alerts.filter((a) => a.kind === 'held');
  assert.deepEqual(held.map((a) => [a.issueKey, a.score, a.missing, a.url]), [['WTR-9', 0.04, 'target_value', ISSUE.url]], 'shown from the poll that held it, after its own comment moved updatedAt');
  e.invalidateSnapshot();
  tracker.issue = { ...tracker.issue, description: 'Rename `weawr` to `weaver` in README.md.', updatedAt: '2026-01-02T00:00:00Z' };
  await e.pollOnce();
  assert.deepEqual(e.picked, ['WTR-9']);
  assert.deepEqual((await e.snapshot()).alerts.filter((a) => a.kind === 'held'), [], 'edited and ready: no longer held');
});

test('an unchanged issue is not asked about again, not even after a restart', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([VAGUE]);
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir));
  const e = engine(dir, { tracker, fetchImpl, store });
  await e.pollOnce();
  await e.pollOnce();
  // a new watcher on the same store
  const e2 = engine(dir, { tracker, fetchImpl, store });
  const r = await e2.pollOnce();
  assert.deepEqual(r.picked, []);
  assert.equal(fetchImpl.calls.length, 1, 'asked once');
  assert.equal(tracker.comments.length, 1, 'commented once');
  assert.deepEqual(tracker.moves, ['Needs Info']);
});

test('an issue edited since its verdict is asked about again', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([VAGUE, READY]);
  const e = engine(dir, { tracker, fetchImpl });
  await e.pollOnce();
  assert.deepEqual(e.picked, []);
  tracker.issue = { ...tracker.issue, description: 'Rename `weawr` to `weaver` in README.md.', updatedAt: '2026-01-02T00:00:00Z' };
  const r = await e.pollOnce();
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].body.state.issue.description, /weaver/);
  assert.deepEqual(r.picked, ['WTR-9']);
});

test('a failed call picks the issue up anyway: HTTP error, network error, timeout, bad body', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  for (const answer of [500, new TypeError('fetch failed'), timeout, { answers: {} }]) {
    const dir = repo(CONFIG());
    const tracker = fakeTracker(ISSUE);
    const fetchImpl = fakeFetch([answer]);
    const logs = [];
    const e = engine(dir, { tracker, fetchImpl, logs });
    const r = await e.pollOnce();
    assert.deepEqual(r.picked, ['WTR-9'], `picked up after ${answer?.message || JSON.stringify(answer)}`);
    assert.deepEqual(tracker.comments, []);
    assert.ok(logs.some((l) => /readiness check failed/.test(l)), 'the failure is logged');
  }
});

test('no "readiness" config means no call at all', async () => {
  const dir = repo(CONFIG(null));
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([VAGUE]);
  const e = engine(dir, { tracker, fetchImpl });
  const r = await e.pollOnce();
  assert.deepEqual(r.picked, ['WTR-9']);
  assert.equal(fetchImpl.calls.length, 0);
});

test('"readiness" without a key warns once and picks up as before', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([]);
  const logs = [];
  const e = engine(dir, { tracker, fetchImpl, env: {}, logs });
  await e.pollOnce(); await e.pollOnce();
  assert.deepEqual(e.picked, ['WTR-9', 'WTR-9']);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(logs.filter((l) => /TYPESAFE_API_KEY is not set/.test(l)).length, 1);
});

test('a dry run shows the verdict and posts nothing', async () => {
  const dir = repo(CONFIG());
  const tracker = fakeTracker(ISSUE);
  const fetchImpl = fakeFetch([VAGUE]);
  const logs = [];
  const e = engine(dir, { tracker, fetchImpl, dry: true, logs });
  const r = await e.pollOnce();
  assert.deepEqual(r.picked, []);
  assert.ok(logs.some((l) => /DRY WTR-9 readiness: not ready \(0\.04 < 0\.5\), missing: a specific value/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /DRY would pick/.test(l)));
  assert.deepEqual(tracker.comments, []);
  assert.deepEqual(tracker.moves, []);
  assert.equal(e.notes.length, 0);
});

test('the readiness config is checked', () => {
  assert.equal(normalizeReadiness(undefined), null);
  assert.deepEqual(normalizeReadiness({}), { threshold: 0.5, model: 'jev-latest' });
  assert.deepEqual(normalizeReadiness({ threshold: 0.7, model: 'jev-2' }), { threshold: 0.7, model: 'jev-2' });
  assert.throws(() => normalizeReadiness({ threshold: 2 }), /threshold/);
  assert.throws(() => normalizeReadiness('yes'), /must be an object/);
});
