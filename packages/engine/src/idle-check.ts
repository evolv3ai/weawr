// What is an idle agent doing? An agent that stops without writing its result file is not always
// asking a question: it may have finished and forgotten the file, or stopped on an error. Before
// weawr reports the stop, it can ask TypeSafe's Jev model what the pane's last lines show, and say
// that instead of guessing. Off unless the config has an "idleCheck" block; any failure of the call
// leaves the report as it was without the check.

export type IdleKind = 'asking' | 'finished' | 'errored' | 'other';
export interface IdleCheckConfig { model: string }
export interface IdleVerdict { kind: IdleKind; confidence: number | null }

export const IDLE_CHECK_URL = 'https://api.typesafe.ai/v1/systemone';
export const IDLE_CHECK_TIMEOUT_MS = 10_000;
export const IDLE_CHECK_KEY_ENV = 'TYPESAFE_API_KEY';
/** How much of the pane goes with the question: the last lines, where an agent's closing words are. */
export const IDLE_TAIL_LINES = 40;

const KINDS: Record<IdleKind, string> = {
  asking: 'The agent put a question to a person or is waiting for a decision',
  finished: 'The agent says the work is done (e.g. a PR is open) but it is idle',
  errored: 'The agent stopped on an error (API error, crash, failed command it gave up on)',
  other: 'None of these',
};

/** The "idleCheck" config block, checked: null (off) when absent. */
export function normalizeIdleCheck(raw: unknown): IdleCheckConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"idleCheck" must be an object like { "model": "jev-latest" }');
  const r = raw as Record<string, unknown>;
  const model = r.model === undefined ? 'jev-latest' : r.model;
  if (typeof model !== 'string' || !model.trim()) throw new Error(`"idleCheck.model" must be a model name, not ${JSON.stringify(r.model)}`);
  return { model: model.trim() };
}

/** The request body: the pane's tail, the issue's title, and one question. */
export function idleRequest(paneTail: string, issueTitle: string, model: string) {
  return {
    model,
    state: { pane_tail: paneTail, issue_title: issueTitle },
    questions: {
      idle: {
        type: 'choice',
        instructions: '`pane_tail` is the end of a coding agent\'s terminal after it stopped without reporting a result. What is the agent doing?',
        criteria: KINDS,
      },
    },
  };
}

/**
 * Ask. Resolves to a verdict, or throws on anything that is not one — an HTTP error, a timeout,
 * a body without a known choice — so the caller can fall back to the report it makes without it.
 */
export async function askIdle({ paneTail, issueTitle, config, apiKey, fetchImpl = fetch, timeoutMs = IDLE_CHECK_TIMEOUT_MS }: {
  paneTail: string;
  issueTitle: string;
  config: IdleCheckConfig;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<IdleVerdict> {
  const res = await fetchImpl(IDLE_CHECK_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(idleRequest(paneTail, issueTitle, config.model)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let body: any;
  try { body = await res.json(); } catch { throw new Error('the response is not JSON'); }
  const choice = body?.answers?.idle?.choice;
  if (typeof choice !== 'string' || !Object.hasOwn(KINDS, choice)) throw new Error('the response has no idle choice');
  const confidence = body?.answers?.idle?.confidence;
  return { kind: choice as IdleKind, confidence: typeof confidence === 'number' ? confidence : null };
}
