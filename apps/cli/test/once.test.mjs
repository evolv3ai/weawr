// `weawr once`: one poll, then it stays up for what it took — the runs it supervises and the pull
// requests they open — and returns when the last of those is merged. The merge is only seen by
// asking GitHub, which here is a fake fetch; herdr and the tracker are fakes too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteStore, teamPaths, loadConfig, storePath } from '@weawr/engine';
import { watch } from '../build/commands/watch.js';

// A claude pickup first asks Claude Code's .claude.json whether it trusts the repository (WTR-70).
// These runs, and the CLIs they spawn, get an empty one of their own — never the machine's.
const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-claude-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
process.on('exit', () => fs.rmSync(claudeHome, { recursive: true, force: true }));

const PROMPTS = fileURLToPath(new URL('../../../packages/recipes/prompts', import.meta.url));
const PR = 'https://github.com/o/r/pull/9';
const ISSUE = { id: 'i7', identifier: 'GH-7', ref: 'GH-7', title: 'Fix the thing', description: '', url: 'https://example.test/7', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'open', type: 'started' } };

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-once-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({
    tracker: 'linear',
    defaults: { worktree: 'none', onPickup: { comment: false }, onDone: { comment: false, notify: false }, onBlocked: { comment: false, notify: false }, onIdle: { comment: false, notify: false }, onMerged: { notify: true } },
    rules: [{ name: 'impl', match: 'any:true' }],
  }));
  return dir;
}

/** A herdr whose agent, once briefed, writes a pr_open result and goes idle. */
function fakeHerdr(repoDir) {
  const started = new Set();
  return {
    notifications: [],
    agent: (name) => ({ agent: 'claude', name, agent_status: 'idle', cwd: repoDir, foreground_cwd: repoDir, pane_id: 'p1', tab_id: 't1', workspace_id: 'w1' }),
    async serverRunning() { return true; },
    async agentGet(name) { return started.has(name) ? this.agent(name) : null; },
    async startAgent({ name }) { started.add(name); return {}; },
    async createWorkspace() { return { workspaceId: 'w1', tabId: 't1', paneId: 'p1' }; },
    async prompt(name, text) {
      const brief = /is in (\S+brief\.md)/.exec(text)?.[1];
      if (brief) fs.writeFileSync(path.join(path.dirname(brief), 'result.json'), JSON.stringify({ status: 'pr_open', prUrl: PR, summary: 'fake agent' }));
    },
    // Taking the brief: seen working, and still working at the settle check. After that it is idle, result written.
    async waitAgent(name, { until = [] } = {}) { await new Promise((r) => setTimeout(r, 5)); return until.includes('working') ? 'working' : until.includes('idle') ? 'timeout' : 'idle'; },
    async readAgent() { return ''; },
    async notify(title, body) { this.notifications.push({ title, body }); },
    async closeWorkspace() {}, async renameWorkspace() {},
  };
}

function fakeTracker() {
  return {
    async me() { return { id: 'me', name: 'me' }; },
    async openIssues() { return [ISSUE]; },
    async issueByKey() { return { ...ISSUE }; },
    async comment() {}, async addLabel() {}, async removeLabel() {}, async assign() {}, async setState() {},
  };
}

/** GitHub's pull request endpoint, answering with `state()` each time it is asked. */
function fakeGitHub(state) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const json = state() === 'merged'
      ? { state: 'closed', merged: true, merged_at: '2026-09-21T12:00:00Z', head: { sha: 'abc' }, base: { ref: 'main' } }
      : { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'abc' }, base: { ref: 'main' } };
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
  f.calls = calls;
  return f;
}

function context(t, dir, { herdr, fetchImpl }) {
  const paths = teamPaths(dir);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-once-user-'));
  t.after(() => fs.rmSync(userDir, { recursive: true, force: true }));
  const lines = [];
  const sources = { paths, promptsRoot: PROMPTS };
  return {
    lines,
    ui: { print: (l) => lines.push(l), log: (...a) => lines.push(a.join(' ')), live: () => {} },
    version: '9.9.9', cli: 'weawr', pkgDir: dir, promptsRoot: PROMPTS, pluginsRoot: dir, demosRoot: dir, webDir: dir,
    paths, sources, userDir, ids: { hostId: 'h', teamId: 'fac0001' }, herdr, fetchImpl,
    config: () => loadConfig(sources), plugins: async () => null, hasConfig: () => true, loadEnv() {},
  };
}

test('once: a run that ends pr_open is followed to its merge, shut down, and the command returns', async (t) => {
  // The PR is read with a GitHub token when there is one; never a real one here.
  const saved = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'ghp_test';
  t.after(() => { if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved; });
  const dir = repo(t);
  const herdr = fakeHerdr(dir);
  const fetchImpl = fakeGitHub(() => 'merged');
  const ctx = context(t, dir, { herdr, fetchImpl });
  const done = watch(ctx, fakeTracker(), 'once').then(() => 'returned');
  const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r('still waiting'), 15_000))]);
  assert.equal(outcome, 'returned', `once returns after the merge:\n${ctx.lines.join('\n')}`);
  assert.ok(fetchImpl.calls.some((u) => u.endsWith('/repos/o/r/pulls/9')), 'GitHub was asked about the PR');
  const store = SqliteStore.open(storePath(teamPaths(dir).stateDir));
  t.after(() => store.close?.());
  const kinds = store.eventsAfter(0).map((e) => e.kind);
  assert.ok(kinds.includes('run.awaiting_merge'), kinds.join(', '));
  assert.ok(kinds.includes('run.merged'), kinds.join(', '));
  assert.deepEqual(Object.values(store.load().runs).map((r) => r.status), ['merged']);
  assert.ok(ctx.lines.some((l) => /is merged/.test(l)), ctx.lines.join('\n'));
});
