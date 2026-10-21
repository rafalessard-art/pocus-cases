import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Page } from '../components/Layout';
import { EvidencePreview } from '../components/EvidencePreview';
import { Badge, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../components/ui';
import { EVIDENCE_ACCEPT, uploadEvidence } from '../lib/evidence';
import { STATUS_LABEL, TONE, latestSubmission, requirementState, type Requirement } from '../lib/itar';
import { formatBytes } from '../lib/media';
import { rpc } from '../lib/supabase';

type Block = { cohort: { id: string; name: string; block_label: string | null; start_date: string | null; end_date: string | null; course: string }; requirements: Requirement[] };

/** Resident view: upload proof of completion for each required learning case, per rotation block. */
export function MyEvidence() {
  const d = useLoad(() => rpc<Block[]>('my_evidence'), []);
  if (d.loading) return <Spinner />;
  if (d.error) return <div className="wrap"><ErrorNote error={d.error} /></div>;
  return (
    <Page kicker="Rotation requirements" title="Learning-case evidence" subtitle="Proof that you completed your required Brightspace learning cases"
      actions={<Link className="btn secondary" to="/requirements">← All requirements</Link>}>
      <div className="notice small" style={{ marginBottom: 18 }}>
        Upload a <strong>screenshot or PDF</strong> from Brightspace that shows your name, the case title and that it is complete. Files are private: only you and the
        faculty evaluating your block can open them. <strong>Do not upload anything that contains patient information.</strong>
      </div>
      {!(d.data ?? []).length && <Empty>You are not in a rotation block yet. Your program administrator adds you to one.</Empty>}
      {(d.data ?? []).map((b) => <BlockCard key={b.cohort.id} b={b} reload={d.reload} />)}
    </Page>
  );
}

function BlockCard({ b, reload }: { b: Block; reload: () => void }) {
  const req = b.requirements.filter((r) => r.required);
  const verified = req.filter((r) => requirementState(r) === 'verified').length;
  return (
    <section style={{ marginBottom: 28 }}>
      <p className="seclabel">{b.cohort.course} · {b.cohort.name}</p>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="small muted">{b.cohort.start_date || b.cohort.end_date ? `${b.cohort.start_date ?? '—'} → ${b.cohort.end_date ?? '—'}` : ''}</span>
        <span className="small"><strong>{verified} of {req.length}</strong> required cases verified</span>
      </div>
      {!b.requirements.length && <Empty>No evidence is required for this block.</Empty>}
      <div className="stack">
        {b.requirements.map((r) => <RequirementRow key={r.id} r={r} cohortId={b.cohort.id} reload={reload} />)}
      </div>
    </section>
  );
}

function RequirementRow({ r, cohortId, reload }: { r: Requirement; cohortId: string; reload: () => void }) {
  const state = requirementState(r);
  const loc = useLocation();
  const target = loc.hash === `#case-${r.id}`;
  useEffect(() => {
    // deep link from "Your next steps" / curriculum: bring this case into view
    if (target) setTimeout(() => document.getElementById(`case-${r.id}`)?.scrollIntoView({ block: 'center' }), 60);
  }, [target, r.id]);
  const last = latestSubmission(r);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [view, setView] = useState<{ path: string; mime: string; name: string } | null>(null);
  const canUpload = state !== 'verified';

  async function send() {
    if (!file) return;
    setBusy(true);
    setErr(undefined);
    try {
      await uploadEvidence(file, r.id, cohortId, note);
      setMsg('Uploaded. Faculty will review it.');
      setFile(null);
      setNote('');
      reload();
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  }

  return (
    <div className="panel" id={`case-${r.id}`} data-testid="evidence-requirement" style={target ? { outline: '2px solid var(--petrol)', outlineOffset: 2 } : undefined}>
      <div className="row between">
        <strong>{r.title}</strong>
        <Badge tone={TONE[state]}>{STATUS_LABEL[state]}</Badge>
      </div>
      {r.description && <p className="small muted" style={{ margin: '6px 0' }}>{r.description}</p>}
      {last && (
        <div className="small">
          Latest upload: {last.file_deleted_at ? <span className="muted">{last.original_filename} (file removed under the retention policy)</span> : (
            <button className="btn ghost small" onClick={() => setView({ path: last.storage_path, mime: last.mime_type, name: last.original_filename })}>{last.original_filename}</button>
          )} · {fmtDate(last.created_at)}
          {(state === 'clarification_requested' || state === 'rejected') && last.reviewer_message && (
            <div className="notice warn small" style={{ marginTop: 8 }} role="status"><strong>Message from faculty:</strong> {last.reviewer_message}</div>
          )}
          {r.submissions.length > 1 && <span className="muted"> · {r.submissions.length} uploads in total</span>}
        </div>
      )}
      {canUpload && (
        <div className="row" style={{ marginTop: 10 }}>
          <label className="btn secondary small" style={{ cursor: 'pointer' }}>
            {file ? 'Change file' : last ? 'Upload a new file' : 'Choose file'}
            <input type="file" accept={EVIDENCE_ACCEPT} className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setMsg(null); }}
              aria-label={`Evidence file for ${r.title}`} data-testid="evidence-file" />
          </label>
          {file && <span className="small">{file.name} · {formatBytes(file.size)}</span>}
          {file && <input type="text" placeholder="Note for faculty (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 180 }} aria-label="Note for faculty" />}
          {file && <button className="btn small" disabled={busy} onClick={send} data-testid="evidence-upload">{busy ? 'Uploading…' : 'Upload'}</button>}
        </div>
      )}
      {msg && <div className="notice ok small" style={{ marginTop: 8 }} role="status">{msg}</div>}
      <ErrorNote error={err} />
      {view && <EvidencePreview {...view} onClose={() => setView(null)} />}
    </div>
  );
}
