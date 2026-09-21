// Is an issue ready to be worked as written? Before a new pickup the watcher can ask TypeSafe's
// Jev model whether the issue says concretely enough what to change. An issue that does not is not
// claimed: its reporter is asked instead, and no agent session is spent finding out. Off unless the
// config has a "readiness" block; any failure of the call lets the pickup go ahead as before.

export interface ReadinessConfig { threshold: number; model: string }
export interface ReadinessVerdict { ready: boolean; score: number; missing: string | null; confidence: number | null }

export const READINESS_URL = 'https://api.typesafe.ai/v1/systemone';
export const READINESS_TIMEOUT_MS = 10_000;
export const READINESS_KEY_ENV = 'TYPESAFE_API_KEY';
/** How many repository paths go with the question: enough to find named files, not the whole tree. */
const MAX_FILES = 300;

/** The "readiness" config block, checked: null (off) when absent. */
export function normalizeReadiness(raw: unknown): ReadinessConfig | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('"readiness" must be an object like { "threshold": 0.5, "model": "jev-latest" }');
  const r = raw as Record<string, unknown>;
  const threshold = r.threshold === undefined ? 0.5 : r.threshold;
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) throw new Error(`"readiness.threshold" must be a number from 0 to 1, not ${JSON.stringify(r.threshold)}`);
  const model = r.model === undefined ? 'jev-latest' : r.model;
  if (typeof model !== 'string' || !model.trim()) throw new Error(`"readiness.model" must be a model name, not ${JSON.stringify(r.model)}`);
  return { threshold, model: model.trim() };
}

/** What `missing` means, in words a reporter can act on. */
export const MISSING_WORDS: Record<string, string> = {
  nothing: 'nothing in particular stood out; it reads as not concrete enough to act on',
  target_value: 'a specific value, name or format it refers to but does not give',
  scope: 'which files or parts of the code are affected',
  acceptance: 'how to tell when it is done',
};

export function missingInWords(missing: string | null): string {
  return (missing && MISSING_WORDS[missing]) || MISSING_WORDS.nothing;
}

/** The request body: the issue, the repository's file list, and the two questions. */
export function readinessRequest(issue: { title?: string; description?: string | null }, repoFiles: string[], model: string) {
  return {
    model,
    state: {
      issue: { title: String(issue.title ?? ''), description: String(issue.description ?? '') },
      repo_files: repoFiles.slice(0, MAX_FILES),
    },
    questions: {
      self_contained: {
        type: 'noul',
        instructions: 'Does `issue` say concretely enough what to change that a developer who only has the issue text and the repository could do it without asking anyone?',
        criteria: {
          true: 'The target files or behaviour and the intended result are stated or directly findable in the repo',
          false: 'It depends on something not written down: an earlier conversation, an unnamed format or name, an unstated preference',
        },
      },
      missing: {
        type: 'choice',
        instructions: 'What is the main thing `issue` leaves unstated that a developer would need?',
        criteria: {
          nothing: 'Nothing essential is missing',
          target_value: 'A specific value, name or format it refers to but does not give',
          scope: 'Which files or parts of the code are affected',
          acceptance: 'How to tell when it is done',
        },
      },
    },
  };
}

/**
 * Ask. Resolves to a verdict, or throws on anything that is not one — an HTTP error, a timeout,
 * a body without a score — so the caller can fail open. `missing` is read only for a not-ready
 * issue: clear issues often get "acceptance", which means nothing there.
 */
export async function askReadiness({ issue, repoFiles, config, apiKey, fetchImpl = fetch, timeoutMs = READINESS_TIMEOUT_MS }: {
  issue: { title?: string; description?: string | null };
  repoFiles: string[];
  config: ReadinessConfig;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ReadinessVerdict> {
  const res = await fetchImpl(READINESS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(readinessRequest(issue, repoFiles, config.model)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let body: any;
  try { body = await res.json(); } catch { throw new Error('the response is not JSON'); }
  const score = body?.answers?.self_contained?.noul;
  if (typeof score !== 'number' || !(score >= 0 && score <= 1)) throw new Error('the response has no self_contained score');
  const ready = score >= config.threshold;
  const choice = body?.answers?.missing?.choice;
  const confidence = body?.answers?.missing?.confidence;
  return {
    ready, score,
    missing: ready ? null : (typeof choice === 'string' ? choice : null),
    confidence: ready || typeof confidence !== 'number' ? null : confidence,
  };
}

/** "0.05 < 0.5 · missing: scope" — the verdict in one line, for logs and the dry run. */
export function describeVerdict(v: ReadinessVerdict, threshold: number): string {
  return v.ready
    ? `ready (${v.score.toFixed(2)} ≥ ${threshold})`
    : `not ready (${v.score.toFixed(2)} < ${threshold}), missing: ${missingInWords(v.missing)}`;
}
