// One rule field, several agents' dialects. The reason this file exists: `"agentKind": "codex"`
// used to start codex and then hand it `--name` and `--permission-mode`, which are Claude Code's
// flags, so the pane died at the prompt and the run was lost before the brief was ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentArgv, claudeTrusts, describeAgent, exitCommandFor, profileFor, TRANSLATED_KINDS } from '../dist/agents.mjs';

const wanted = { name: 'GH-7.review', permissionMode: 'auto', model: 'a-model', effort: 'high' };

test('the same four wishes become each agent\'s own flags', () => {
  assert.deepEqual(agentArgv({ kind: 'claude', ...wanted }),
    ['--name', 'GH-7.review', '--permission-mode', 'auto', '--model', 'a-model', '--effort', 'high']);
  // codex has no session-name flag, spells effort as a TOML config override, and says "unattended"
  // with automatic approval rather than a permission mode.
  assert.deepEqual(agentArgv({ kind: 'codex', ...wanted }),
    ['--model', 'a-model', '-c', 'model_reasoning_effort="high"', '--approve-for-me']);
});

test('an agent with no profile still runs, on the one flag they all share', () => {
  assert.deepEqual(agentArgv({ kind: 'gemini', ...wanted }), ['--model', 'a-model']);
  assert.deepEqual(agentArgv({ kind: 'grok' }), []);
  assert.deepEqual(TRANSLATED_KINDS, ['claude', 'codex']);
});

test('an unattended run is never given an agent with no boundary left', () => {
  // Claude's "auto" maps to codex's widest *sandboxed* setting, not to
  // --dangerously-bypass-approvals-and-sandbox. Turning a sandbox off has to be typed out by a
  // person in agentArgs; it is not something a permission mode quietly means.
  const args = agentArgv({ kind: 'codex', permissionMode: 'auto' }).join(' ');
  // --approve-for-me *is* the workspace-write sandbox, and codex refuses --sandbox next to it.
  assert.match(args, /--approve-for-me/);
  assert.doesNotMatch(args, /--sandbox/);
  assert.doesNotMatch(args, /dangerously/);
  // an interactive mode asks for no automatic approval at all
  assert.deepEqual(agentArgv({ kind: 'codex', permissionMode: 'plan', model: 'm' }), ['--model', 'm']);
});

test('a rule\'s own flags go last, so they can override anything the profile chose', () => {
  const args = agentArgv({ kind: 'codex', permissionMode: 'auto', extra: ['--dangerously-bypass-approvals-and-sandbox'] });
  assert.equal(args.at(-1), '--dangerously-bypass-approvals-and-sandbox');
  assert.deepEqual(agentArgv({ kind: 'claude', model: 'opus', extra: ['--fallback-model', 'sonnet'] }),
    ['--model', 'opus', '--fallback-model', 'sonnet']);
});

test('nothing asked for means nothing passed', () => {
  assert.deepEqual(agentArgv(), []);
  assert.deepEqual(agentArgv({ kind: 'claude' }), []);
});

test('each agent is asked to leave in its own words', () => {
  assert.equal(exitCommandFor('claude'), '/exit');
  assert.equal(exitCommandFor('codex'), '/quit');
  assert.equal(exitCommandFor('something-new'), '/exit');
});

test('a kind that is an Object property is not a profile', () => {
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.deepEqual(agentArgv({ kind: bad, name: 'x', permissionMode: 'auto', model: 'm' }), ['--model', 'm'], bad);
    assert.equal(typeof profileFor(bad).argv, 'function', bad);
  }
});

test('the startup line says what a rule runs, and stays quiet when it is the default', () => {
  assert.equal(describeAgent({}), 'claude');
  assert.equal(describeAgent({ agentKind: 'codex', model: 'gpt-5-codex', effort: 'high' }), 'codex gpt-5-codex effort high');
});

// WTR-70: a brief typed onto Claude Code's folder-trust dialog takes "No, exit". Trust is read from
// a .claude.json in a temp dir, never the real one: every call below names its home in `env`.
function claudeHome(t, projects) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (projects !== undefined) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects }));
  return home;
}

test('a folder Claude Code trusts is trusted, and so is anything inside it', (t) => {
  const home = claudeHome(t, { '/work/repo': { hasTrustDialogAccepted: true }, '/work/other': { hasTrustDialogAccepted: false } });
  assert.equal(claudeTrusts('/work/repo', { env: { HOME: home } }), true);
  assert.equal(claudeTrusts('/work/repo/', { env: { HOME: home } }), true);
  assert.equal(claudeTrusts('/work/repo/.weawr/worktrees/x', { env: { HOME: home } }), true, 'an ancestor counts');
});

test('a folder Claude Code has not trusted is not, and neither is one beside or above a trusted one', (t) => {
  const home = claudeHome(t, { '/work/repo': { hasTrustDialogAccepted: true }, '/work/other': { hasTrustDialogAccepted: false } });
  assert.equal(claudeTrusts('/work/other', { env: { HOME: home } }), false);
  assert.equal(claudeTrusts('/work/repo-two', { env: { HOME: home } }), false, 'a name prefix is not an ancestor');
  assert.equal(claudeTrusts('/work', { env: { HOME: home } }), false);
  assert.equal(claudeTrusts('/work/repo', { env: { HOME: claudeHome(t, {}) } }), false, 'no projects at all');
});

test('no .claude.json, or one that is not JSON, is unknown rather than untrusted', (t) => {
  assert.equal(claudeTrusts('/work/repo', { env: { HOME: claudeHome(t) } }), null);
  const bad = claudeHome(t);
  fs.writeFileSync(path.join(bad, '.claude.json'), '{ not json');
  assert.equal(claudeTrusts('/work/repo', { env: { HOME: bad } }), null);
  assert.equal(claudeTrusts('/work/repo', { env: {} }), null, 'no home to look in');
});

test('CLAUDE_CONFIG_DIR is where .claude.json is read from when it is set', (t) => {
  const home = claudeHome(t, { '/work/repo': { hasTrustDialogAccepted: false } });
  const config = claudeHome(t, { '/work/repo': { hasTrustDialogAccepted: true } });
  assert.equal(claudeTrusts('/work/repo', { env: { HOME: home } }), false);
  assert.equal(claudeTrusts('/work/repo', { env: { HOME: home, CLAUDE_CONFIG_DIR: config } }), true);
  assert.equal(claudeTrusts('/work/repo', { env: { HOME: config, CLAUDE_CONFIG_DIR: claudeHome(t) } }), null, 'the home file is not a fallback');
});
