import { useEffect, useState, type ReactNode } from 'react';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="row" role="status" style={{ padding: 30, justifyContent: 'center' }}>
      <span className="spinner" aria-hidden /> <span className="muted">{label}</span>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="notice error" role="alert">
      {msg}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'bad' | 'info' | 'petrol'; children: ReactNode }) {
  return <span className={`badge ${tone ?? ''}`}>{children}</span>;
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Generic async loader hook with reload. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; loading: boolean; reload: () => void; setData: (d: T) => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    fn()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}

export function pct(v: number | string | null | undefined, digits = 0) {
  if (v === null || v === undefined || v === '') return '—';
  return `${Number(v).toFixed(digits)}%`;
}

export function fmtDate(v?: string | null, withTime = true) {
  if (!v) return '—';
  const d = new Date(v);
  return withTime
    ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function Bar({ value }: { value: number | null | undefined }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, Number(value)));
  const cls = value == null ? '' : v < 50 ? 'low' : v < 70 ? 'mid' : '';
  return (
    <div className={`bar ${cls}`} role="img" aria-label={value == null ? 'not available' : `${v.toFixed(0)} percent`}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}

export function DomainBars({ domains }: { domains: { key: string; label: string; pct?: number | null; mean_pct?: number | null; n_items?: number; pending?: number }[] }) {
  if (!domains?.length) return <p className="muted small">No domain data.</p>;
  return (
    <div>
      {domains.map((d) => {
        const v = d.pct ?? d.mean_pct ?? null;
        return (
          <div className="domainrow" key={d.key}>
            <span>
              {d.label}
              {d.n_items != null && <span className="muted small"> · {d.n_items} item{d.n_items === 1 ? '' : 's'}</span>}
            </span>
            <Bar value={v} />
            <span className="num" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {v == null ? (d.pending ? 'pending' : '—') : pct(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Confirm({ title, body, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="stack">
        <div>{body}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : ''}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
