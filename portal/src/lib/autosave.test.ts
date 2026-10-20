import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutosaveQueue, type Answer, type KV } from './autosave';

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** Fake server that applies the same seq rule as save_responses(). */
function fakeServer() {
  const store = new Map<string, Answer>();
  let down = false;
  const calls: Answer[][] = [];
  return {
    store,
    calls,
    setDown: (d: boolean) => (down = d),
    send: async (items: Answer[]) => {
      calls.push(items);
      if (down) throw new Error('Failed to fetch');
      for (const a of items) {
        const cur = store.get(a.item_id);
        if (!cur || cur.seq < a.seq) store.set(a.item_id, a);
      }
      return { status: 'in_progress' as const };
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AutosaveQueue', () => {
  it('debounces and batches changes, keeping only the latest answer per item', async () => {
    const s = fakeServer();
    const q = new AutosaveQueue({ attemptId: 'a1', send: s.send, storage: new MemKV(), now: () => 1000 });
    q.set('i1', { selected: ['a'] }, false);
    q.set('i1', { selected: ['b'] }, false);
    q.set('i2', { selected: ['c'] }, true);
    expect(s.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toHaveLength(2);
    expect(s.store.get('i1')!.response).toEqual({ selected: ['b'] });
    expect(s.store.get('i2')!.flagged).toBe(true);
    expect(q.status).toBe('saved');
  });

  it('keeps unsent answers in local storage while offline and resends with back-off', async () => {
    const s = fakeServer();
    const kv = new MemKV();
    const statuses: string[] = [];
    const q = new AutosaveQueue({ attemptId: 'a2', send: s.send, storage: kv, onStatus: (x) => statuses.push(x) });
    s.setDown(true);
    q.set('i1', { selected: ['a'] }, false);
    await vi.advanceTimersByTimeAsync(500);
    expect(statuses).toContain('offline');
    expect(JSON.parse(kv.getItem(q.key)!)).toHaveLength(1);
    s.setDown(false);
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.store.get('i1')).toBeTruthy();
    expect(kv.getItem(q.key)).toBeNull();
    expect(q.status).toBe('saved');
  });

  it('restores answers from a crashed session and only re-sends ones newer than the server', async () => {
    const kv = new MemKV();
    kv.setItem('pocus-autosave:a3', JSON.stringify([
      { item_id: 'i1', response: { selected: ['a'] }, flagged: false, seq: 50 },
      { item_id: 'i2', response: { selected: ['b'] }, flagged: false, seq: 10 },
    ]));
    const s = fakeServer();
    const q = new AutosaveQueue({ attemptId: 'a3', send: s.send, storage: kv, now: () => 1 }, 20);
    const restored = q.restore({ i1: 40, i2: 20 });
    expect(restored.map((r) => r.item_id)).toEqual(['i1']);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.store.get('i1')!.seq).toBe(50);
    expect(s.store.has('i2')).toBe(false);
    // later edits get a higher seq than anything restored
    q.set('i2', { selected: ['c'] }, false);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.store.get('i2')!.seq).toBeGreaterThan(50);
  });

  it('an answer changed while a request is in flight is not lost', async () => {
    let release!: () => void;
    const seen: Answer[][] = [];
    const send = (items: Answer[]) => {
      seen.push(items);
      return new Promise<{ status: 'in_progress' }>((r) => (release = () => r({ status: 'in_progress' })));
    };
    const q = new AutosaveQueue({ attemptId: 'a4', send, storage: new MemKV() });
    q.set('i1', { selected: ['a'] }, false);
    const p = q.flush();
    q.set('i1', { selected: ['b'] }, false); // changed during flight
    release();
    // the queue immediately sends the newer answer in a second request
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    release();
    await p;
    expect(seen[1][0].response).toEqual({ selected: ['b'] });
    expect(q.pendingCount).toBe(0);
  });

  it('stops when the server reports the attempt closed (time expired)', async () => {
    const onClosed = vi.fn();
    const q = new AutosaveQueue({
      attemptId: 'a5', storage: new MemKV(), onClosed,
      send: async () => ({ status: 'submitted', reason: 'time_expired' }),
    });
    q.set('i1', { selected: ['a'] }, false);
    await q.flush();
    expect(onClosed).toHaveBeenCalledWith('time_expired');
    expect(q.status).toBe('closed');
  });

  it('beacon sends whatever is pending', () => {
    const beacon = vi.fn();
    const q = new AutosaveQueue({ attemptId: 'a6', storage: new MemKV(), beacon, send: async () => ({ status: 'in_progress' }) });
    q.set('i9', { text: 'hello' }, false);
    q.beacon();
    expect(beacon).toHaveBeenCalledOnce();
    expect(beacon.mock.calls[0][0][0].item_id).toBe('i9');
  });
});
