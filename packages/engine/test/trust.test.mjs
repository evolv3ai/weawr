// WTR-70: on a machine where Claude Code has never opened the repository, the brief landed on its
// folder-trust dialog, took the default "No, exit", and the run died in a second with the issue
// claimed. A claude pickup now asks .claude.json first (a temp one here, never the real file) and
// holds when the repository is not trusted; other agents are picked up as before.
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

const PROMPTS = fileURLToPath(new URL('../../recipes/prompts', import.meta.url));
const ISSUE = { id: 'i9', identifier: 'WTR-9', ref: 'WTR-9', title: 'Rename the thing', description: 'Rename it.', url: 'https://example.test/9', labels: ['ai'], comments: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', project: null, team: null, assignee: null, assignees: [], state: { name: 'Todo', type: 'unstarted' } };
const HELD = /\] held: Claude Code has not trusted .+ — run `claude` there once and choose "Yes, I trust this folder"$/;

function tmp(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function repo(t, rule = {}) {
  const dir = tmp(t, 'weawr-trust-');
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({ tracker: 'linear', defaults: { worktree: 'none' }, rules: [{ name: 'r', match: 'any:true', ...rule }] }));
  return dir;
}
/** A CLAUDE_CONFIG_DIR whose .claude.json says `trusted` about `dir`. */
function claudeConfig(t, dir, trusted) {
  const home = tmp(t, 'weawr-claude-');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: trusted } } }));
  return home;
}
function engine(dir, env, { dry = false } = {}) {
  const paths = teamPaths(dir);
  const logs = []; const notes = []; const picked = [];
  const tracker = { async me() { return { id: 'me', name: 'me' }; }, async openIssues() { return [{ ...ISSUE }]; } };
  const herdr = { async notify(title, body) { notes.push(body); } };
  const e = new TeamEngine({ cfg: loadConfig({ paths, promptsRoot: PROMPTS }), tracker, herdr, paths, promptsRoot: PROMPTS, store: SqliteStore.open(storePath(paths.stateDir)), ids: { hostId: 'h', teamId: 'f' }, log: (l) => logs.push(l), env, dry });
  e.pickUp = async (issue) => { picked.push(issue.identifier); };
  return { e, logs, notes, picked };
}

test('an untrusted repository picks nothing up, says why each cycle, and notifies once', async (t) => {
  const dir = repo(t);
  const { e, logs, notes, picked } = engine(dir, { CLAUDE_CONFIG_DIR: claudeConfig(t, dir, false) });
  const r = await e.pollOnce();
  await e.pollOnce();
  assert.deepEqual(picked, []);
  assert.deepEqual(r.picked, []);
  assert.deepEqual(r.held, ['WTR-9']);
  const held = logs.filter((l) => l.includes('] held: '));
  assert.equal(held.length, 2, 'one line per poll cycle');
  assert.match(held[0], HELD);
  assert.ok(held[0].includes(dir));
  assert.equal(notes.length, 1, 'one notification per watcher start');
});

test('a trusted repository, or one inside a trusted folder, is picked up', async (t) => {
  const dir = repo(t);
  const { e, logs, picked } = engine(dir, { CLAUDE_CONFIG_DIR: claudeConfig(t, dir, true) });
  await e.pollOnce();
  assert.deepEqual(picked, ['WTR-9']);
  assert.equal(logs.filter((l) => l.includes('] held: ')).length, 0);
  const parent = engine(dir, { CLAUDE_CONFIG_DIR: claudeConfig(t, path.dirname(dir), true) });
  await parent.e.pollOnce();
  assert.deepEqual(parent.picked, ['WTR-9']);
});

test('dry-run prints the held line instead of the pick, and notifies nobody', async (t) => {
  const dir = repo(t);
  const untrusted = engine(dir, { CLAUDE_CONFIG_DIR: claudeConfig(t, dir, false) }, { dry: true });
  await untrusted.e.pollOnce();
  assert.ok(untrusted.logs.some((l) => HELD.test(l)));
  assert.ok(!untrusted.logs.some((l) => l.includes('] DRY would pick')));
  assert.equal(untrusted.notes.length, 0);
  const trusted = engine(dir, { CLAUDE_CONFIG_DIR: claudeConfig(t, dir, true) }, { dry: true });
  await trusted.e.pollOnce();
  assert.ok(trusted.logs.some((l) => l.includes('] DRY would pick WTR-9')));
});

test('no .claude.json to read picks up as before, with one warning', async (t) => {
  const dir = repo(t);
  const { e, logs, picked } = engine(dir, { CLAUDE_CONFIG_DIR: tmp(t, 'weawr-claude-') });
  await e.pollOnce();
  await e.pollOnce();
  assert.deepEqual(picked, ['WTR-9', 'WTR-9']);
  assert.equal(logs.filter((l) => /could not tell whether Claude Code trusts/.test(l)).length, 1);
});

test('another agent kind is not held on Claude Code\'s trust', async (t) => {
  const dir = repo(t, { agentKind: 'codex' });
  const { e, logs, picked } = engine(dir, { CLAUDE_CONFIG_DIR: claudeConfig(t, dir, false) });
  await e.pollOnce();
  assert.deepEqual(picked, ['WTR-9']);
  assert.equal(logs.filter((l) => l.includes('] held: ')).length, 0);
});
