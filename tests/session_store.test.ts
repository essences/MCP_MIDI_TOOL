import { afterEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore, persistedSessionResult } from '../src/sessionStore.js';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-')); roots.push(root); return root; }
test('restart preserves completed results and marks active history interrupted', async () => {
  const root = await setup(), first = new SessionStore(root); await first.initialize();
  await first.save({ playbacks: [], recordings: [], captures: [{ captureId: 'done', done: true, result: { notes: [60] } }, { captureId: 'active', done: false }] });
  const next = new SessionStore(root); await next.initialize(); await next.save({ playbacks: [], captures: [], recordings: [] });
  expect((await persistedSessionResult(root, 'get_single_capture_status', { captureId: 'done' })).result.notes).toEqual([60]);
  expect(await persistedSessionResult(root, 'get_single_capture_status', { captureId: 'active' })).toMatchObject({ done: true, status: 'interrupted', interrupted: true });
  expect(await persistedSessionResult(root, 'runtime.status')).toBeUndefined();
});
test('queued snapshots remain valid and completed statuses expire after 24 hours', async () => {
  const root = await setup(), store = new SessionStore(root); await store.initialize();
  await Promise.all(Array.from({ length: 20 }, (_, n) => store.save({ playbacks: [{ playbackId: `p${n}`, done: true }], captures: [], recordings: [] })));
  const doc = JSON.parse(await fs.readFile(path.join(root, 'sessions/status.json'), 'utf8')); expect(doc.version).toBe(1); expect(doc.sessions).toHaveLength(20);
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
  expect(await persistedSessionResult(root, 'get_playback_status', { playbackId: 'p1' })).toBeUndefined();
});
test('waiting and saving recordings become interrupted; history list filters and limits', async () => {
  const root = await setup(), store = new SessionStore(root); await store.initialize();
  await store.save({ playbacks: [], captures: [], recordings: [
    { recordingId: 'waiting', status: 'waiting_for_input', startedAt: '2026-10-15T00:00:00Z' },
    { recordingId: 'saving', status: 'stopped_manually', saveStatus: 'saving', startedAt: '2026-10-15T01:00:00Z' },
  ] });
  expect(await persistedSessionResult(root, 'get_continuous_recording_status', { recordingId: 'waiting' })).toMatchObject({ status: 'interrupted', interrupted: true });
  expect(await persistedSessionResult(root, 'get_continuous_recording_status', { recordingId: 'saving' })).toMatchObject({ status: 'interrupted', saveStatus: 'failed' });
  expect(await persistedSessionResult(root, 'list_continuous_recordings')).toMatchObject({ recordings: [], total: 2, activeCount: 0, completedCount: 2 });
  const completed = await persistedSessionResult(root, 'list_continuous_recordings', { status: 'completed', limit: 1 });
  expect(completed.recordings.map((value:any)=>value.recordingId)).toEqual(['saving']);
});
