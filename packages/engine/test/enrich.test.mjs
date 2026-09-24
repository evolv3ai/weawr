// The Enricher's budget: how often it asks the tracker and GitHub about each task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Enricher } from '../dist/enrich.js';

const T0 = Date.parse('2026-09-23T12:00:00Z');
const MIN = 60_000;

function setup() {
  const asked = [];
  const tracker = { issueByKey: async (key) => { asked.push(key); return { state: { type: 'started', name: 'In Progress' } }; } };
  let now = T0;
  const e = new Enricher({ tracker, ghRepo: null, ghToken: null, host: 'github.com', clock: () => now });
  const settle = () => new Promise((r) => setImmediate(r));
  return { e, asked, at: (t) => { now = t; }, settle };
}

test('an in-flight task is asked of the tracker every 90s', async () => {
  const { e, asked, at, settle } = setup();
  const tasks = [{ key: 'WTR-1', bucket: 'inflight', runs: [] }];
  e.refresh(tasks, T0); await settle();
  at(T0 + 2 * MIN); e.refresh(tasks, T0 + 2 * MIN); await settle();
  assert.deepEqual(asked, ['WTR-1', 'WTR-1']);
});

test('a task finished this week is asked of the tracker every 30 min, not every 90s', async () => {
  const { e, asked, at, settle } = setup();
  const tasks = [{ key: 'WTR-2', bucket: 'done', finishedAt: new Date(T0 - 60 * MIN).toISOString(), runs: [] }];
  e.refresh(tasks, T0); await settle();
  at(T0 + 2 * MIN); e.refresh(tasks, T0 + 2 * MIN); await settle();
  assert.deepEqual(asked, ['WTR-2']);
  at(T0 + 31 * MIN); e.refresh(tasks, T0 + 31 * MIN); await settle();
  assert.deepEqual(asked, ['WTR-2', 'WTR-2']);
});

test("a task finished this week still has its PR asked of GitHub every 90s", async () => {
  const { e, at, settle } = setup();
  const seen = [];
  e.sources.ghToken = 't';
  e.sources.fetchImpl = async (url) => { seen.push(url); return new Response(JSON.stringify({ state: 'open', merged: false, html_url: 'x' }), { status: 200 }); };
  const tasks = [{ key: 'WTR-3', bucket: 'done', finishedAt: new Date(T0 - 60 * MIN).toISOString(), prUrl: 'https://github.com/o/r/pull/9', runs: [] }];
  e.refresh(tasks, T0); await settle(); await settle();
  const first = seen.length;
  at(T0 + 2 * MIN); e.refresh(tasks, T0 + 2 * MIN); await settle(); await settle();
  assert.ok(first >= 1 && seen.length > first, `GitHub asked ${first} then ${seen.length} times`);
});
