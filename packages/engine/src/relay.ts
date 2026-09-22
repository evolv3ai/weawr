// Relay a reply from the tracker to the agent that asked. An agent that stops to ask a question is
// reported on its issue and waits; a person who answers there, as a comment, should not also have to
// find the herdr pane and type it. While a run waits on a question, each new comment on its issue is
// put to TypeSafe's Jev model — does it answer what the agent asked? — and the ones that do are typed
// into the agent's pane. Off unless the config has a "relayReplies" block.

import { COORDINATOR } from './comments.js';

export interface RelayConfig { threshold: number; model: string }
export interface RelayVerdict { answers: boolean; score: number }

export const RELAY_URL = 'https://api.typesafe.ai/v1/systemone';
export const RELAY_TIMEOUT_MS = 10_000;
export const RELAY_KEY_ENV = 'TYPESAFE_API_KEY';

/** The "relayReplies" config block, checked: null (off) when absent. */
export function normalizeRelay(raw: unknown): RelayConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"relayReplies" must be an object like { "threshold": 0.5, "model": "jev-latest" }');
  const r = raw as Record<string, unknown>;
  const threshold = r.threshold === undefined ? 0.5 : r.threshold;
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) throw new Error(`"relayReplies.threshold" must be a number from 0 to 1, not ${JSON.stringify(r.threshold)}`);
  const model = r.model === undefined ? 'jev-latest' : r.model;
  if (typeof model !== 'string' || !model.trim()) throw new Error(`"relayReplies.model" must be a model name, not ${JSON.stringify(r.model)}`);
  return { threshold, model: model.trim() };
}

/**
 * Is this run waiting on an answer to a question? It reported one (`notified.idle`, with the time
 * and the pane it reported), no dialog is up, and the idle check, when it ran, called it a question.
 */
export function awaitingReply(run: any): boolean {
  return run?.status === 'running' && !!run.notified?.idle && !run.notified?.blocked && !!run.askedAt
    && (!run.idleKind || run.idleKind === 'asking');
}

/**
 * Written by weawr, not a person: a coordinator comment (it carries the byline anywhere in it) or a
 * role's own report ("✅ **weawr** as `impl` finished …"). The author is no help — on Linear it is
 * the same person whose token weawr uses.
 */
export function isWeawrComment(body: string): boolean {
  const first = String(body ?? '').split('\n')[0];
  return String(body ?? '').includes(COORDINATOR) || /^\S{0,3}\s*\*\*weawr\*\*/.test(first);
}

/**
 * The comments on an issue that a waiting run has not yet considered: newer than the question and
 * than the last one it looked at, not weawr's own, oldest first.
 */
export function newReplies(comments: Array<{ body: string; createdAt: string; author: string }>, run: { askedAt?: string | null; relayedUpTo?: string | null }) {
  const after = Math.max(Date.parse(run.askedAt || '') || 0, Date.parse(run.relayedUpTo || '') || 0);
  return (comments || [])
    .filter((c) => Date.parse(c.createdAt) > after && !isWeawrComment(c.body))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** The request body: what the agent asked, the comment, and one question. */
export function relayRequest(question: string, comment: string, model: string) {
  return {
    model,
    state: { question: String(question ?? ''), comment: String(comment ?? '') },
    questions: {
      answers: {
        type: 'noul',
        instructions: 'Does `comment` answer or respond to what the agent asked in `question` (the last lines of its terminal), so that the agent can go on with its task?',
        criteria: {
          true: 'It answers the question, makes the decision asked for, or tells the agent what to do next',
          false: 'It is about something else: a status note, a question to someone else, an unrelated remark',
        },
      },
    },
  };
}

/** Ask. Resolves to a verdict, or throws on anything that is not one, so the caller can relay anyway. */
export async function askRelay({ question, comment, config, apiKey, fetchImpl = fetch, timeoutMs = RELAY_TIMEOUT_MS }: {
  question: string;
  comment: string;
  config: RelayConfig;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RelayVerdict> {
  const res = await fetchImpl(RELAY_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(relayRequest(question, comment, config.model)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let body: any;
  try { body = await res.json(); } catch { throw new Error('the response is not JSON'); }
  const score = body?.answers?.answers?.noul;
  if (typeof score !== 'number' || !(score >= 0 && score <= 1)) throw new Error('the response has no answers score');
  return { answers: score >= config.threshold, score };
}

/** What is typed into the pane: each reply under its own heading, oldest first, then the go-ahead. */
export function relayPrompt(issueKey: string, replies: Array<{ body: string; author: string }>): string {
  return [...replies.map((c) => `Reply on ${issueKey} from ${c.author} in the tracker:\n\n${c.body.trim()}`), 'Carry on with the task.'].join('\n\n');
}
