// What a Claude Code run cost, from Claude Code's own session transcript. Claude Code keeps one
// JSONL file per session under ~/.claude/projects/<slug of the working directory>/, and appends a
// `{"type":"cost-state","totalCostUSD":…,"modelUsage":{…}}` record as the session goes: the last
// one is the session's running total. Nothing here writes, and nothing reads a transcript whole.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RunCost { usd: number; outputTokens: number; cacheReadTokens: number }

/** Where Claude Code keeps its per-project transcripts: `$CLAUDE_CONFIG_DIR/projects`, else ~/.claude/projects. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

/** The directory Claude Code files a working directory's sessions under: every character not a letter or digit becomes `-`. */
export function claudeProjectDir(worktree: string, projectsDir = claudeProjectsDir()): string {
  return path.join(projectsDir, path.resolve(worktree).replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * The session transcript a run wrote: the newest `.jsonl` in the worktree's project directory that
 * was written to since the run started. Null when there is none — the agent never started a
 * session there, or Claude Code keeps its transcripts elsewhere.
 */
export function claudeTranscript(worktree: string, sinceMs = 0, projectsDir = claudeProjectsDir()): { file: string; size: number; mtimeMs: number } | null {
  const dir = claudeProjectDir(worktree, projectsDir);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best: { file: string; size: number; mtimeMs: number } | null = null;
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const file = path.join(dir, n);
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile() || st.mtimeMs < sinceMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { file, size: st.size, mtimeMs: st.mtimeMs };
  }
  return best;
}

/** One `cost-state` record as a cost: the session's dollars, and its output and cache-read tokens summed over the models it used. */
export function costOf(rec: any): RunCost | null {
  if (!rec || rec.type !== 'cost-state' || typeof rec.totalCostUSD !== 'number') return null;
  let outputTokens = 0, cacheReadTokens = 0;
  for (const u of Object.values<any>(rec.modelUsage || {})) {
    outputTokens += Number(u?.outputTokens) || 0;
    cacheReadTokens += Number(u?.cacheReadInputTokens ?? u?.cacheReadTokens) || 0;
  }
  return { usd: rec.totalCostUSD, outputTokens, cacheReadTokens };
}

const CHUNK = 64 * 1024;

/**
 * The last `cost-state` record in a transcript, read from the end backwards a chunk at a time, so
 * a long session costs one small read. Null when the file is missing or has no such record.
 */
export function lastCostState(file: string): RunCost | null {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    let pos = fs.fstatSync(fd).size;
    // What is left of the file before `pos` that has not been split into lines yet: the start of
    // a line whose end was in the chunk read last.
    let carry = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      const data = Buffer.concat([buf, carry]);
      // The first line in `data` may begin before `pos`; keep it for the next round unless this is the file's start.
      const firstNl = pos > 0 ? data.indexOf(10) : -1;
      if (pos > 0 && firstNl < 0) { carry = data; continue; }
      const lines = data.subarray(firstNl + 1).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"cost-state"')) continue;
        try { const c = costOf(JSON.parse(lines[i])); if (c) return c; } catch { /* a line still being written */ }
      }
      carry = pos > 0 ? data.subarray(0, firstNl + 1) : Buffer.alloc(0);
    }
    return null;
  } catch { return null; } finally { fs.closeSync(fd); }
}
