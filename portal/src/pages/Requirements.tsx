import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import { Badge, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../components/ui';
import { useAuth } from '../lib/auth';
import { REQ_LABEL, REQ_TONE, completion, scanPct, type Rotation, type RotationReq } from '../lib/requirements';
import { rpc } from '../lib/supabase';

type Block = { cohort: { id: string; name: string; start_date: string | null; end_date: string | null; course: string }; rotation: Rotation };

/** Resident view: every mandatory rotation activity, what is verified and what is still needed. */
export function Requirements() {
  const d = useLoad(() => rpc<Block[]>('my_requirements'), []);
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <div className="wrap"><ErrorNote error={d.error} /></div>;
  return (
    <Page kicker="Rotation" title="Rotation requirements" subtitle="What is complete, what is waiting for faculty, and what you still need to do">
      <div className="notice small" style={{ marginBottom: 18 }}>
        <strong>Verified</strong> items were confirmed by faculty (or scored by the portal). Numbers <em>you</em> report are shown separately and only count once faculty
        verify them. Never enter patient details (names, MRNs, dates of birth) anywhere in the portal.
      </div>
      {!(d.data ?? []).length && <Empty>You are not in a rotation block yet. Your program administrator adds you to one.</Empty>}
      {(d.data ?? []).map((b) => <BlockReqs key={b.cohort.id} b={b} onChange={(rot) => d.setData((d.data ?? []).map((x) => (x.cohort.id === b.cohort.id ? { ...x, rotation: rot } : x)))} />)}
    </Page>
  );
}

function BlockReqs({ b, onChange }: { b: Block; onChange: (r: Rotation) => void }) {
  const c = completion(b.rotation.requirements);
  return (
    <section style={{ marginBottom: 30 }}>
      <p className="seclabel">{b.cohort.course} · {b.cohort.name}</p>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="small muted">{b.cohort.start_date || b.cohort.end_date ? `${b.cohort.start_date ?? '—'} → ${b.cohort.end_date ?? '—'}` : ''}</span>
        <span className="small" data-testid="req-summary"><strong>{c.done} of {c.total}</strong> requirements complete{c.notYetDue ? ` · ${c.notYetDue} not yet due` : ''}</span>
      </div>
      <div className="stack">
        {b.rotation.requirements.map((r) => (
          <ReqCard key={r.id} r={r} cohortId={b.cohort.id} rotation={b.rotation} onChange={onChange} />
        ))}
      </div>
    </section>
  );
}

function ReqCard({ r, cohortId, rotation, onChange }: { r: RotationReq; cohortId: string; rotation: Rotation; onChange: (r: Rotation) => void }) {
  const [note, setNote] = useState(r.resident_note);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const { profile } = useAuth();
  const residentStages = r.stages.filter((s) => s.by === 'resident');
  const locked = ['verified', 'not_applicable', 'not_yet_due'].includes(r.status);

  async function set(status: 'in_progress' | 'submitted', stage: string | null = null) {
    setBusy(true);
    setErr(undefined);
    try {
      onChange(await rpc<Rotation>('set_requirement_status', { p_requirement: r.id, p_learner: profile?.id, p_cohort: cohortId, p_status: status, p_stage: stage, p_note: note }));
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  }

  return (
    <div className="panel" data-testid={`my-req-${r.key}`}>
      <div className="row between">
        <strong>{r.title}</strong>
        <Badge tone={REQ_TONE[r.status]}>{REQ_LABEL[r.status]}</Badge>
      </div>
      {r.description && <p className="small muted" style={{ margin: '6px 0' }}>{r.description}</p>}
      <div className="small">
        {r.detail && <div>{r.detail}</div>}
        {r.verified_by_name && r.status === 'verified' && <div className="muted">Verified by {r.verified_by_name} · {fmtDate(r.verified_at, false)}</div>}
        {r.faculty_message && !locked && <div className="notice warn small" role="status" style={{ marginTop: 8 }}><strong>Message from faculty:</strong> {r.faculty_message}</div>}
      </div>

      {r.kind === 'learning_cases' && <div style={{ marginTop: 8 }}><Link className="btn secondary small" to="/evidence">Upload Brightspace evidence</Link></div>}
      {r.kind === 'exam' && r.status !== 'verified' && <div style={{ marginTop: 8 }}><Link className="btn secondary small" to="/exams">Examinations</Link></div>}
      {r.kind === 'epa' && r.status !== 'verified' && <p className="small muted" style={{ margin: '6px 0 0' }}>Recorded by faculty from your Elentra assessments.</p>}
      {r.kind === 'scan_log' && <ScanProgress rotation={rotation} cohortId={cohortId} onChange={onChange} />}

      {r.kind === 'attestation' && r.resident_submits && !locked && (
        <div className="stack" style={{ marginTop: 10 }}>
          <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-label={`Note to faculty about ${r.title}`}
            placeholder={r.stages.length ? 'Note to faculty (optional, e.g. topic and planned date) — no patient details' : 'Note to faculty (optional) — no patient details'} data-testid={`my-req-note-${r.key}`} />
          <div className="row">
            {residentStages.map((s) => (
              <button key={s.key} className="btn secondary small" disabled={busy} onClick={() => set('in_progress', s.key)} data-testid={`my-req-stage-${r.key}-${s.key}`}>
                {r.stage === s.key ? '✓ ' : ''}{s.label}
              </button>
            ))}
            {r.status === 'not_started' && !residentStages.length && <button className="btn secondary small" disabled={busy} onClick={() => set('in_progress')}>Mark in progress</button>}
            <button className="btn small" disabled={busy || r.status === 'submitted'} onClick={() => set('submitted')} data-testid={`my-req-submit-${r.key}`}>
              {r.status === 'submitted' ? 'Submitted — awaiting faculty' : 'Submit for faculty confirmation'}
            </button>
            {r.evidence_requirement_id && <Link className="btn ghost small" to="/evidence">Optional: upload evidence</Link>}
          </div>
        </div>
      )}
      <ErrorNote error={err} />
    </div>
  );
}

function ScanProgress({ rotation, cohortId, onChange }: { rotation: Rotation; cohortId: string; onChange: (r: Rotation) => void }) {
  const cats = rotation.scans.categories;
  const [edit, setEdit] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();

  async function save() {
    setBusy(true);
    setErr(undefined);
    try {
      onChange(await rpc<Rotation>('report_scans', {
        p_cohort: cohortId, p_counts: cats.filter((c) => counts[c.id] !== undefined && counts[c.id] !== '').map((c) => ({ category: c.id, count: Number(counts[c.id]) })),
      }));
      setEdit(false);
      setCounts({});
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th>Category</th><th>Verified by faculty</th><th className="num">Target</th><th className="num">Reported by you</th></tr></thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.id} data-testid={`my-scan-${c.key}`}>
                <td><strong>{c.label}</strong>{c.views_note && <div className="small muted">{c.views_note}{c.verified >= c.target && !c.views_confirmed ? ' — views not yet confirmed' : ''}</div>}</td>
                <td style={{ minWidth: 150 }}>
                  <div className="bar" aria-hidden><span style={{ width: `${scanPct(c)}%`, background: c.met ? 'var(--moss)' : undefined }} /></div>
                  <span className="small">{c.verified}/{c.target}{c.met ? ' ✓' : ''}</span>
                </td>
                <td className="num">{c.target}</td>
                <td className="num">
                  {edit ? (
                    <input type="number" min={0} max={2000} style={{ width: 76 }} aria-label={`Scans you have done for ${c.label}`} data-testid={`my-scan-count-${c.key}`}
                      value={counts[c.id] ?? String(c.reported ?? '')} onChange={(e) => setCounts({ ...counts, [c.id]: e.target.value })} />
                  ) : (c.reported ?? '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="small"><strong>{rotation.scans.verified_total}/{rotation.scans.target_total}</strong> verified</span>
        {!edit && <button className="btn secondary small" onClick={() => setEdit(true)} data-testid="my-scan-edit">Update my scan counts</button>}
        {edit && <button className="btn small" disabled={busy} onClick={save} data-testid="my-scan-save">Save — ask faculty to review</button>}
        {edit && <button className="btn ghost small" onClick={() => setEdit(false)}>Cancel</button>}
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Report how many scans you have archived for review (numbers only). Faculty review the images in QPath and record the verified totals.
      </p>
      <ErrorNote error={err} />
    </div>
  );
}
