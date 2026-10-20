/**
 * Reliable autosave for exam answers.
 *
 *  - Every change gets a strictly increasing sequence number. The server only
 *    accepts a write whose seq is higher than the stored one, so retries and
 *    out-of-order deliveries can never roll an answer back.
 *  - Unsent changes are mirrored to localStorage immediately, so a crash, a
 *    closed tab or a dead network loses nothing: on the next load they are
 *    restored and re-sent.
 *  - Sends are debounced and batched; failures retry with back-off and on the
 *    browser's `online` event.
 *  - On page hide, pending changes are sent with `fetch(…, { keepalive: true })`.
 */

export type Answer = { item_id: string; response: unknown; flagged: boolean; seq: number };
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'closed';
export type SendResult = { status: 'in_progress' | 'submitted'; reason?: string };

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export type AutosaveOptions = {
  attemptId: string;
  send: (items: Answer[]) => Promise<SendResult>;
  beacon?: (items: Answer[]) => void;
  storage?: KV | null;
  debounceMs?: number;
  now?: () => number;
  onStatus?: (s: SaveStatus, info?: { lastSavedAt?: number; error?: string; pending: number }) => void;
  onClosed?: (reason?: string) => void;
};

const BACKOFF = [1000, 2000, 5000, 10000, 15000];

export class AutosaveQueue {
  private pending = new Map<string, Answer>();
  private seq: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private failures = 0;
  private closed = false;
  status: SaveStatus = 'idle';
  lastSavedAt?: number;
  readonly key: string;

  constructor(private o: AutosaveOptions, serverMaxSeq = 0) {
    this.key = `pocus-autosave:${o.attemptId}`;
    const now = (o.now ?? Date.now)();
    // Date-based floor keeps seq increasing across reloads, the server max
    // guards against a clock that moved backwards.
    this.seq = Math.max(now, serverMaxSeq);
  }

  /** Changes saved locally by an earlier page load that never reached the server. */
  restore(serverSeqs: Record<string, number>): Answer[] {
    const raw = this.o.storage?.getItem(this.key);
    if (!raw) return [];
    let saved: Answer[] = [];
    try {
      saved = JSON.parse(raw);
    } catch {
      return [];
    }
    const out: Answer[] = [];
    for (const a of saved) {
      if (a && typeof a.item_id === 'string' && a.seq > (serverSeqs[a.item_id] ?? 0)) {
        this.seq = Math.max(this.seq, a.seq);
        this.pending.set(a.item_id, a);
        out.push(a);
      }
    }
    this.persist();
    if (out.length) this.schedule(0);
    return out;
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  set(itemId: string, response: unknown, flagged: boolean) {
    if (this.closed) return;
    const a: Answer = { item_id: itemId, response, flagged, seq: this.nextSeq() };
    this.pending.set(itemId, a);
    this.persist();
    this.emit(this.status === 'offline' ? 'offline' : 'saving');
    this.schedule(this.o.debounceMs ?? 400);
  }

  get pendingCount() {
    return this.pending.size;
  }

  /** Send everything now; resolves when the server has acknowledged (or failed). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed) return;
    if (this.inflight) {
      await this.inflight;
      if (this.pending.size && !this.closed) return this.flush();
      return;
    }
    if (!this.pending.size) {
      if (this.status === 'saving') this.emit('saved');
      return;
    }
    const batch = [...this.pending.values()];
    this.emit('saving');
    this.inflight = (async () => {
      try {
        const res = await this.o.send(batch);
        // drop entries that were not changed again while the request was in flight
        for (const a of batch) {
          const cur = this.pending.get(a.item_id);
          if (cur && cur.seq === a.seq) this.pending.delete(a.item_id);
        }
        this.persist();
        this.failures = 0;
        this.lastSavedAt = (this.o.now ?? Date.now)();
        if (res.status === 'submitted') {
          this.closed = true;
          this.emit('closed');
          this.o.onClosed?.(res.reason);
          return;
        }
        this.emit(this.pending.size ? 'saving' : 'saved');
      } catch (e) {
        this.failures += 1;
        const msg = e instanceof Error ? e.message : String(e);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        this.emit(offline || /network|fetch|load failed/i.test(msg) ? 'offline' : 'error', msg);
        this.schedule(BACKOFF[Math.min(this.failures - 1, BACKOFF.length - 1)]);
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
    if (this.pending.size && !this.closed && this.failures === 0) await this.flush();
  }

  /** Best-effort send during page unload. */
  beacon() {
    if (this.pending.size && this.o.beacon && !this.closed) this.o.beacon([...this.pending.values()]);
  }

  /** The attempt is over; stop sending and clear the local mirror. */
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.o.storage?.removeItem(this.key);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private persist() {
    try {
      if (this.pending.size) this.o.storage?.setItem(this.key, JSON.stringify([...this.pending.values()]));
      else this.o.storage?.removeItem(this.key);
    } catch {
      /* storage full or blocked — the in-memory queue still works */
    }
  }

  private emit(s: SaveStatus, error?: string) {
    this.status = s;
    this.o.onStatus?.(s, { lastSavedAt: this.lastSavedAt, error, pending: this.pending.size });
  }
}
