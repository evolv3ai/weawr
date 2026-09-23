// A run's cost from Claude Code's session transcript: the last `cost-state` record, read from the
// end of the file, and null when there is no file or no record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDir, claudeTranscript, costOf, lastCostState } from '../dist/cost.js';
import { teamView, sumCosts } from '../dist/projection.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-cost-'));
const line = (o) => JSON.stringify(o) + '\n';
const costState = (usd, out, cache) => ({ type: 'cost-state', totalCostUSD: usd, modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: out, cacheReadInputTokens: cache, costUSD: usd - 0.1 }, 'claude-haiku-4-5': { outputTokens: 5, cacheReadInputTokens: 7, costUSD: 0.1 } } });

test('a transcript with two cost-state lines gives the last one\'s totals, summed over its models', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line({ type: 'user', message: 'hi' }) + line(costState(1.42, 100, 2000)) + line({ type: 'assistant', message: 'x'.repeat(300_000) }) + line(costState(6.97, 900, 50_000)) + line({ type: 'assistant', message: 'bye' }));
  assert.deepEqual(lastCostState(file), { usd: 6.97, outputTokens: 905, cacheReadTokens: 50_007 });
});

test('the record is found across chunk boundaries, and one near the start of a long file is still found', () => {
  const dir = tmp();
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line({ type: 'user' }) + line(costState(2.5, 1, 2)) + line({ type: 'assistant', message: 'y'.repeat(200_000) }) + line({ type: 'assistant', message: 'z'.repeat(70_000) }));
  assert.deepEqual(lastCostState(file), { usd: 2.5, outputTokens: 6, cacheReadTokens: 9 });
  // A cost-state line longer than one chunk, straddling two.
  fs.writeFileSync(file, line({ ...costState(3, 1, 1), pad: 'p'.repeat(150_000) }) + line({ type: 'user', message: 'q'.repeat(100) }));
  assert.equal(lastCostState(file).usd, 3);
});

test('a missing file, a file with no record, and a half-written last line give what is known', () => {
  const dir = tmp();
  assert.equal(lastCostState(path.join(dir, 'nope.jsonl')), null);
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, line({ type: 'user' }) + line({ type: 'assistant' }));
  assert.equal(lastCostState(file), null);
  fs.writeFileSync(file, line(costState(1, 1, 1)) + '{"type":"cost-state","totalCostUSD":2,"mod');
  assert.equal(lastCostState(file).usd, 1);
  assert.equal(costOf({ type: 'cost-state' }), null, 'a record without a total is not a cost');
});

test('the transcript is found from the worktree path the way Claude Code files it, newest since the run started', () => {
  const projects = tmp();
  const wt = '/home/me/dev/app/.weawr/worktrees/gh-7-fix';
  const dir = claudeProjectDir(wt, projects);
  assert.equal(path.basename(dir), '-home-me-dev-app--weawr-worktrees-gh-7-fix');
  assert.equal(claudeTranscript(wt, 0, projects), null, 'no directory: no transcript');
  fs.mkdirSync(dir);
  const old = path.join(dir, 'old.jsonl'), cur = path.join(dir, 'cur.jsonl');
  fs.writeFileSync(old, line(costState(9, 1, 1))); fs.writeFileSync(cur, line(costState(1, 1, 1)));
  fs.utimesSync(old, new Date(1000e3), new Date(1000e3)); fs.utimesSync(cur, new Date(2000e3), new Date(2000e3));
  assert.equal(claudeTranscript(wt, 0, projects).file, cur);
  assert.equal(claudeTranscript(wt, 3000e3, projects), null, 'a session older than the run is not the run\'s');
});

test('the snapshot carries each Claude run\'s cost, null for another agent or an unknown one, and totals per task and team', () => {
  const config = { name: 'app', roles: ['impl', 'review'], defaults: { agentKind: 'claude' }, rules: [{ name: 'implement', role: 'impl' }, { name: 'tech-lead', role: 'review', agentKind: 'codex' }] };
  const run = (rule, role, issueKey) => ({ rule, role, issueKey, status: 'done', title: issueKey, startedAt: '2026-09-08T10:00:00Z', finishedAt: '2026-09-08T11:00:00Z', agentName: `${issueKey}-${role}`, result: { status: 'pr_open' } });
  const runs = { 'GH-1@impl': run('implement', 'impl', 'GH-1'), 'GH-1@review': run('tech-lead', 'review', 'GH-1'), 'GH-2@impl': run('implement', 'impl', 'GH-2'), 'GH-3@impl': run('implement', 'impl', 'GH-3') };
  const costs = { 'GH-1@impl': { usd: 1.42, outputTokens: 10, cacheReadTokens: 100 }, 'GH-1@review': { usd: 99, outputTokens: 1, cacheReadTokens: 1 }, 'GH-2@impl': { usd: 6.97, outputTokens: 20, cacheReadTokens: 200 } };
  const v = teamView({ id: 'app', repo: '/r', config, state: { runs }, costs, now: Date.parse('2026-09-08T12:00:00Z') });
  const byKey = Object.fromEntries(v.issues.flatMap((i) => i.runs).map((r) => [r.key, r.cost]));
  assert.deepEqual(byKey['GH-1@impl'], { usd: 1.42, outputTokens: 10, cacheReadTokens: 100 });
  assert.equal(byKey['GH-1@review'], null, 'a codex run has no Claude cost');
  assert.equal(byKey['GH-3@impl'], null, 'no transcript: unknown');
  assert.deepEqual(v.issues.find((i) => i.key === 'GH-1').cost, { usd: 1.42, outputTokens: 10, cacheReadTokens: 100, runs: 1 });
  assert.equal(v.issues.find((i) => i.key === 'GH-3').cost, null);
  assert.equal(v.cost.runs, 2); assert.ok(Math.abs(v.cost.usd - 8.39) < 1e-9); assert.equal(v.cost.outputTokens, 30);
  assert.equal(teamView({ id: 'x', repo: '/r', state: { runs: {} } }).cost, null);
  assert.equal(sumCosts([{ cost: null }]), null);
});
