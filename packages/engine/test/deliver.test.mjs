// Handing an agent its brief: a send that stalled can sit unsubmitted in Claude Code's input box, so
// before a retry the input line is emptied (one ctrl+u through herdr) and the brief is sent once more;
// the agent gets it exactly once. A first send that is taken is never preceded by a clear, and a
// clear that fails is logged and the brief goes anyway.
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
const BRIEF = 'You are working issue GH-7. Your full brief is in /x/brief.md — read that file first.';

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weawr-deliver-')));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.weawr'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.weawr', 'config.json'), JSON.stringify({ tracker: 'linear', defaults: { worktree: 'none' }, rules: [{ name: 'r', match: 'any:true' }] }));
  made.push(dir);
  return dir;
}
const stalled = () => Object.assign(new Error('agent_prompt_stalled'), { code: 'agent_prompt_stalled' });
/** A herdr that records every call in order; `prompts` scripts each send: an error to throw, or nothing. */
function fakeHerdr({ prompts = [], clearFails = false } = {}) {
  const h = {
    calls: [],
    async sendKeys(paneId, ...keys) { h.calls.push({ op: 'keys', paneId, keys }); if (clearFails) throw new Error('pane_not_found'); },
    async prompt(name, text) { h.calls.push({ op: 'prompt', name, text }); const next = prompts.shift(); if (next) throw next; },
    async waitAgent() { return 'working'; },
  };
  return h;
}
function setup(herdrOpts) {
  const dir = repo();
  const runDir = path.join(dir, '.weawr', 'state', 'runs', 'GH-7');
  fs.mkdirSync(runDir, { recursive: true });
  const run = { rule: 'r', pass: 1, status: 'running', issueKey: 'GH-7', agentName: 'gh-7', paneId: 'p1', dir: runDir, resultPath: path.join(runDir, 'result.json'), pendingPrompt: true, promptText: BRIEF };
  const paths = teamPaths(dir);
  const store = SqliteStore.open(storePath(paths.stateDir));
  store.save({ runs: { 'GH-7': run }, nudges: {} });
  const herdr = fakeHerdr(herdrOpts);
  const logs = [];
  const e = new TeamEngine({ cfg: loadConfig({ paths, promptsRoot: PROMPTS }), tracker: {}, herdr, paths, promptsRoot: PROMPTS, store, ids: { hostId: 'h', teamId: 'fac0001' }, log: (l) => logs.push(l) });
  return { e, herdr, logs, run: e.state.runs['GH-7'] };
}

test('a stalled first send is followed by one clear and one prompt, and the brief is sent once', async () => {
  const { e, herdr, logs, run } = setup({ prompts: [stalled()] });
  assert.equal(await e.deliverPrompt('GH-7', run), true);
  assert.deepEqual(herdr.calls.map((c) => c.op), ['prompt', 'keys', 'prompt']);
  assert.deepEqual(herdr.calls[1], { op: 'keys', paneId: 'p1', keys: ['ctrl+u'] });
  const sent = herdr.calls[2].text;
  assert.equal(sent, BRIEF);
  assert.equal(sent.split(BRIEF).length - 1, 1, 'the retry carries the brief exactly once');
  assert.equal(run.pendingPrompt, false);
  assert.ok(logs.some((l) => /sending it again/.test(l)));
});

test('a brief taken the first time is never preceded by a clear', async () => {
  const { e, herdr } = setup();
  assert.equal(await e.deliverPrompt('GH-7', e.state.runs['GH-7']), true);
  assert.deepEqual(herdr.calls.map((c) => c.op), ['prompt']);
});

test('a clear that fails is logged and the brief is sent anyway', async () => {
  const { e, herdr, logs, run } = setup({ prompts: [stalled()], clearFails: true });
  assert.equal(await e.deliverPrompt('GH-7', run), true);
  assert.deepEqual(herdr.calls.map((c) => c.op), ['prompt', 'keys', 'prompt']);
  assert.ok(logs.some((l) => /could not clear the agent's input line.*sending it anyway/.test(l)), logs.join('\n'));
});
