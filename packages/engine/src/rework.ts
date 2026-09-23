// `weawr rework <KEY>`: send a PR back to its agent. By hand this was five steps, each easy to miss —
// close the PR (an open one keeps the run awaiting merge, never re-matched), reset, delete the pickup
// comment (the claim guard skips an issue that has one), take the claim label off, and move the
// issue back to the queue. Here they run in that order, one printed line each, and the first one
// that fails stops the rest with a message naming it: nothing is left half done without saying so.
//
// Everything outside is injected — the tracker, a `gh` runner, and the forget step (which goes to
// the running owner when there is one, like `reset`) — so the order is testable without a network.
import * as _claim from './claim.mjs';
import * as _expr from './expr.mjs';
import * as _pr from './adapters/pr.mjs';
import { resetTargets } from './application.js';
const { CLAIM_MARKER, LEGACY_CLAIM_MARKER, claimLabelFor, issueKeyOf, pickupMarker } = _claim as Record<string, any>;
const { parse } = _expr as Record<string, any>;
const { parsePrUrl } = _pr as Record<string, any>;

/** Runs `gh` with these arguments and resolves to its stdout; rejects with its stderr. */
export type GhRunner = (args: string[]) => Promise<string>;

export interface ReworkOptions {
  /** An issue key (every role's run on it) or a run key (just that one), as `reset` takes. */
  key: string;
  note?: string | null;
  runs: Record<string, any>;
  rules: Array<{ name: string; match?: string; role?: string | null; claimLabel?: string | null }>;
  tracker: any;
  gh: GhRunner;
  /** Forget the runs exactly as `reset` does; resolves to the run keys it forgot. */
  forget: () => Promise<string[]>;
  print: (line: string) => void;
}

/**
 * The workflow state a rule's `match` picks issues up from: its first `state:` (or `status:`) term
 * that is asked for rather than excluded — not under a `not`, not `!=`, and not a glob, which names
 * no one state to move to. null when the expression names none (or does not parse).
 */
export function queueStateOf(match: string | null | undefined): string | null {
  if (!match) return null;
  let ast: any;
  try { ast = parse(match); } catch { return null; }
  const walk = (n: any): string | null => {
    if (!n || n.k === 'not') return null;
    if (n.k === 'term') return (n.field === 'state' || n.field === 'status') && n.op === ':' && !/[*?]/.test(n.value) ? n.value : null;
    return walk(n.l) ?? walk(n.r);
  };
  return walk(ast);
}

export async function rework({ key, note = null, runs, rules, tracker, gh, forget, print }: ReworkOptions): Promise<void> {
  const targets = resetTargets(runs, key);
  if (!targets.length) throw new Error(`no run recorded for ${key}, so there is nothing to send back (\`weawr status\` lists the runs)`);
  const issueKey = issueKeyOf(key);
  const ruleOf = (run: any) => rules.find((r) => r.name === run?.rule) || null;
  // The run that holds the PR is the one being sent back; its rule says where the queue is.
  const withPr = targets.map((k) => runs[k]).filter((r) => parsePrUrl(r.prUrl || r.result?.prUrl));
  const prUrls = [...new Set(withPr.map((r) => parsePrUrl(r.prUrl) ? r.prUrl : r.result.prUrl))] as string[];

  let n = 0;
  const step = async (what: string, fn: () => Promise<void>) => {
    n++;
    try { await fn(); } catch (e: any) {
      throw new Error(`step ${n} (${what}) failed: ${e?.message || e}${n > 1 ? ' — the steps before it are done; fix this and finish by hand, or run `weawr rework` again once the run is back' : ''}`);
    }
  };

  const issue = await tracker.issueByKey(issueKey);
  if (!issue) throw new Error(`${tracker.constructor?.label || 'the tracker'} has no issue ${issueKey}`);

  await step('post the note', async () => {
    if (!note) { print(`1. no --note, nothing posted`); return; }
    await tracker.comment(issue.id, note);
    print(`1. posted the note on ${issueKey}`);
  });

  await step('close the PR', async () => {
    if (!prUrls.length) { print(`2. no pull request recorded for ${key}`); return; }
    for (const url of prUrls) {
      const state = String(JSON.parse(await gh(['pr', 'view', url, '--json', 'state'])).state || '').toUpperCase();
      if (state !== 'OPEN') { print(`2. ${url} is already ${state.toLowerCase() || 'not open'}, left as it is`); continue; }
      await gh(['pr', 'close', url]);
      print(`2. closed ${url} (the branch is kept)`);
    }
  });

  await step('forget the run', async () => {
    const forgot = await forget();
    print(forgot.length ? `3. forgot ${forgot.join(', ')}` : `3. no run called ${key} left to forget`);
  });

  await step('delete the pickup comments', async () => {
    // Naming the issue sends every role back, so every role's pickup goes; naming one run key sends
    // back that role, and its marker is the only one that counts. The finished/blocked comments
    // carry no marker and stay.
    const markers = key === issueKey
      ? [CLAIM_MARKER, LEGACY_CLAIM_MARKER]
      : targets.flatMap((k) => [pickupMarker(runs[k].role), pickupMarker(runs[k].role, LEGACY_CLAIM_MARKER)]);
    const pickups = (issue.comments || []).filter((c: any) => markers.some((m: string) => c.body.includes(m)));
    if (!pickups.length) { print(`4. no weawr pickup comment on ${issueKey}`); return; }
    if (typeof tracker.deleteComment !== 'function') throw new Error(`the ${tracker.constructor?.label || ''} tracker cannot delete comments`);
    for (const c of pickups) {
      if (c.id === undefined || c.id === null) throw new Error('the tracker did not say which comment is which (no comment id)');
      await tracker.deleteComment(c.id);
    }
    print(`4. deleted ${pickups.length} pickup comment${pickups.length === 1 ? '' : 's'}`);
  });

  await step('remove the claim label', async () => {
    const labels = [...new Set(targets.map((k) => runs[k].claimed || claimLabelFor(ruleOf(runs[k]))).filter(Boolean))] as string[];
    if (!labels.length) { print(`5. no claim label to remove`); return; }
    for (const label of labels) {
      if (!issue.labels.some((l: string) => l.toLowerCase() === label.toLowerCase())) { print(`5. '${label}' is not on ${issueKey}`); continue; }
      await tracker.removeLabel(issue.id, label);
      print(`5. removed '${label}'`);
    }
  });

  await step('move the issue to the queue', async () => {
    const run = withPr[0] || runs[targets[0]];
    const rule = ruleOf(run);
    const want = queueStateOf(rule?.match);
    const now = issue.state?.name || 'its current state';
    if (!want) { print(`6. rule "${run.rule}" names no state: in its match, so ${issueKey} stays in ${now}`); return; }
    const moved = await tracker.setState(issue, want);
    print(`6. moved ${issueKey} to ${moved?.name || want}`);
  });
}
