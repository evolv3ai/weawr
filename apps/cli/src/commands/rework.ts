// `weawr rework <KEY> [--note <text>]`: send a PR back to its agent in one command. The steps and
// their order are the engine's (rework.ts); this wires them to the tracker, `gh` and `reset`.
import { execFile } from 'node:child_process';
import { resetTargets, rework as runRework } from '@weawr/engine';
import type { GhRunner } from '@weawr/engine';
import { makeTracker } from '../context.js';
import type { Context } from '../context.js';
import { forgetRuns, listRuns } from './status.js';

const USAGE = 'usage: weawr rework <KEY> [--note <text>]';

export function parseReworkArgs(args: string[]): { key: string; note: string | null } {
  let key: string | null = null;
  let note: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--note') { if (i + 1 >= args.length) throw new Error(`--note needs a text — ${USAGE}`); note = args[++i]; }
    else if (a.startsWith('--note=')) note = a.slice('--note='.length);
    else if (a.startsWith('-')) throw new Error(`unknown option ${a} — ${USAGE}`);
    else if (key === null) key = a;
    else throw new Error(`one key at a time — ${USAGE}`);
  }
  if (!key) throw new Error(USAGE);
  return { key, note: note?.trim() ? note : null };
}

const gh: GhRunner = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(`gh ${args.slice(0, 2).join(' ')}: ${String(stderr || err.message).trim()}`));
    else resolve(stdout);
  });
});

export async function rework(ctx: Context, args: string[]): Promise<void> {
  const { key, note } = parseReworkArgs(args);
  const cfg = ctx.config();
  const runs = await listRuns(ctx);
  // A key with no run is refused by rework() before it touches anything, credentials included.
  const tracker = resetTargets(runs, key).length ? makeTracker(ctx, cfg) : null;
  await runRework({ key, note, runs, rules: cfg.rules, tracker, gh, forget: () => forgetRuns(ctx, key), print: (line) => console.log(line) });
}
