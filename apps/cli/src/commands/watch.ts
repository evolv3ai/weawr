// `weawr` (run), `weawr once`, `weawr dry-run`: the watcher itself. Running and polling once take
// the team's ownership and answer on its socket; a dry run reads and touches nothing.
import { PR_POLL_MS } from '@weawr/engine';
import type { TeamEngine } from '@weawr/engine';
import { createApplication, hostApplication, makeEngine, takeOwnership } from '../context.js';
import type { Context } from '../context.js';
import { updateReminder } from './update.js';

export async function watch(ctx: Context, tracker: any, mode: 'run' | 'once' | 'dry-run'): Promise<void> {
  const cfg = ctx.config();
  if (!(await ctx.herdr.serverRunning())) throw new Error('herdr server is not running (start herdr first)');
  if (mode === 'dry-run') {
    const app = makeEngine(ctx, { cfg, tracker, dry: true });
    const r = await app.pollOnce();
    ctx.ui.log(`${r.scanned} open issues scanned, ${r.candidates} matched, ${r.picked.length} picked`);
    return;
  }
  const ownership = takeOwnership(ctx, cfg);
  const engine = makeEngine(ctx, { cfg, tracker, ownership, register: true });
  engine.hooks.updateReminder = () => updateReminder(ctx, { notify: true });
  const ipc = await hostApplication(ctx, createApplication(engine));
  if (mode === 'once') {
    await engine.resume();
    const r = await engine.pollOnce();
    ctx.ui.log(`${r.scanned} open issues scanned, ${r.candidates} matched, ${r.picked.length} picked`);
    await untilSettled(engine, r.picked, (m) => ctx.ui.log(m));
    await ipc.close();
    ownership.release();
    return;
  }
  // The watcher must outlive its own mistakes: anything that escapes the per-poll and per-run
  // handlers is logged and the loop carries on. Fix the config or the issue and it is retried.
  process.on('uncaughtException', (e: any) => ctx.ui.log(`unexpected error (kept running): ${e.stack || e.message}`));
  process.on('unhandledRejection', (e: any) => ctx.ui.log(`unexpected error (kept running): ${e?.stack || e?.message || e}`));
  // A signal stops scheduling and checkpoints; the agents stay up for their owner to inspect. A
  // second signal exits at once.
  let signalled = false;
  const onSignal = () => { if (signalled) process.exit(130); signalled = true; ctx.ui.log('stopping after this poll (again to exit at once); agents are left running'); engine.stop(); };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) { process.removeAllListeners(sig); process.on(sig, onSignal); }
  await engine.loop();
  await ipc.close();
  ownership.release();
  // The supervisors are parked on herdr waits of hours: the agents are left running, on purpose,
  // but this process is not. Recovery re-attaches to them on the next start.
  ctx.herdr.endWaits?.();
  ctx.ui.log('stopped; the agents are left running');
  process.exit(0);
}

/**
 * `once` after its poll: stay up while the runs it took are supervised and while the PRs they
 * opened wait to be merged, then return. Merges are only seen by checkMerges(), which the watch
 * loop calls on every poll and `once` polls only the once, so it is called here every PR_POLL_MS —
 * and at once when a supervisor ends, because that run may just have opened a PR. Only the runs
 * this process supervised are waited for: a PR an earlier watcher left open is not its business.
 */
async function untilSettled(engine: TeamEngine, picked: string[], log: (m: string) => void, stepMs = 1000): Promise<void> {
  const mine = new Set<string>([...picked, ...engine.supervising]);
  const awaitingMerge = () => [...mine].some((k) => engine.state.runs[k]?.status === 'awaiting_merge');
  if (!engine.supervising.size && !awaitingMerge()) return;
  log(`supervising ${engine.supervising.size} run(s), then waiting for the PRs they open to be merged; Ctrl-C to leave earlier`);
  let nextCheck = awaitingMerge() ? 0 : Date.now() + PR_POLL_MS;
  let supervised = engine.supervising.size;
  for (;;) {
    for (const k of engine.supervising) mine.add(k);
    if (engine.supervising.size < supervised) nextCheck = 0;
    supervised = engine.supervising.size;
    if (!supervised && !awaitingMerge()) return;
    if (Date.now() >= nextCheck) {
      nextCheck = Date.now() + PR_POLL_MS;
      try { await engine.checkMerges(); } catch (e: any) { log(`checking merges failed (will try again): ${e.message}`); }
      continue;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
