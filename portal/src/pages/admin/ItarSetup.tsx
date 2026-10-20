import { useState } from 'react';
import { Page } from '../../components/Layout';
import { Badge, Confirm, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../../components/ui';
import { cohorts as loadCohorts, pocusCourse } from '../../lib/content';
import { deleteEvidenceFiles } from '../../lib/evidence';
import { rpc, supabase } from '../../lib/supabase';

type Req = {
  id: string; course_id: string; cohort_id: string | null; kind: string; source: string; title: string; description: string; external_ref: string | null;
  required: boolean; sort: number; archived_at: string | null;
};

/** Admin: what residents must upload per rotation/block, and how long evidence files are kept. */
export function ItarSetup() {
  return (
    <Page kicker="Administration" title="ITAR setup" subtitle="Required learning-case evidence and evidence retention">
      <Requirements />
      <Retention />
    </Page>
  );
}

function Requirements() {
  const course = useLoad(pocusCourse, []);
  const coh = useLoad(loadCohorts, []);
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('evidence_requirements').select('*').order('archived_at', { nullsFirst: true }).order('sort').order('title');
    if (error) throw error;
    return data as Req[];
  }, []);
  const blank = { title: '', description: 'Upload a screenshot or PDF from Brightspace showing that you completed this case.', external_ref: '', cohort_id: '', required: true, sort: 100 };
  const [f, setF] = useState(blank);
  const [edit, setEdit] = useState<Req | null>(null);
  const [err, setErr] = useState<unknown>();

  async function add() {
    setErr(undefined);
    const { error } = await supabase.from('evidence_requirements').insert({
      course_id: course.data!.id, title: f.title.trim(), description: f.description, external_ref: f.external_ref || null,
      cohort_id: f.cohort_id || null, required: f.required, sort: Number(f.sort) || 0,
    });
    if (error) setErr(error);
    else {
      setF(blank);
      list.reload();
    }
  }
  async function saveEdit() {
    if (!edit) return;
    const { error } = await supabase.from('evidence_requirements').update({
      title: edit.title.trim(), description: edit.description, external_ref: edit.external_ref || null, cohort_id: edit.cohort_id || null,
      required: edit.required, sort: Number(edit.sort) || 0,
    }).eq('id', edit.id);
    if (error) setErr(error);
    else {
      setEdit(null);
      list.reload();
    }
  }
  async function archive(r: Req, on: boolean) {
    const { error } = await supabase.from('evidence_requirements').update({ archived_at: on ? new Date().toISOString() : null }).eq('id', r.id);
    if (error) setErr(error);
    list.reload();
  }
  const blockName = (id: string | null) => (id ? coh.data?.find((c) => c.id === id)?.name ?? 'one block' : 'All blocks');

  return (
    <section>
      <p className="seclabel">Required learning cases</p>
      <p className="small muted">
        Residents upload proof of completion for each item. Any number of items; scope an item to one block if it only applies there. Archiving hides an item
        from new blocks without touching evidence already submitted. The draft items were created from the portal's required teaching cases — confirm
        them against the Brightspace course.
      </p>
      {list.loading ? <Spinner /> : <ErrorNote error={list.error} />}
      <div className="tablewrap" style={{ marginBottom: 16 }}>
        <table className="data">
          <thead><tr><th className="num">Order</th><th>Title</th><th>Applies to</th><th>Brightspace reference</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(list.data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="num">{r.sort}</td>
                <td><strong>{r.title}</strong><div className="small muted">{r.description}</div></td>
                <td className="small">{blockName(r.cohort_id)}</td>
                <td className="small mono">{r.external_ref || '—'}</td>
                <td>{r.archived_at ? <Badge>archived</Badge> : r.required ? <Badge tone="petrol">required</Badge> : <Badge>optional</Badge>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost small" onClick={() => setEdit({ ...r })}>Edit</button>
                  <button className="btn ghost small" onClick={() => archive(r, !r.archived_at)}>{r.archived_at ? 'Restore' : 'Archive'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card flat stack">
        <h3>{edit ? 'Edit requirement' : 'Add a requirement'}</h3>
        {(() => {
          const v = edit ?? f;
          const set = (k: string, val: any) => (edit ? setEdit({ ...edit, [k]: val } as Req) : setF({ ...f, [k]: val }));
          return (
            <div className="formgrid">
              <label className="field">Title<input type="text" value={v.title} onChange={(e) => set('title', e.target.value)} data-testid="req-title" /></label>
              <label className="field">Brightspace reference <span className="hint">module name or link (optional)</span>
                <input type="text" value={v.external_ref ?? ''} onChange={(e) => set('external_ref', e.target.value)} />
              </label>
              <label className="field">Applies to
                <select value={v.cohort_id ?? ''} onChange={(e) => set('cohort_id', e.target.value)}>
                  <option value="">All blocks of this rotation</option>
                  {(coh.data ?? []).filter((c) => !c.archived_at).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="field">Order<input type="number" value={v.sort} onChange={(e) => set('sort', e.target.value)} /></label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>Instructions for residents<textarea rows={2} value={v.description} onChange={(e) => set('description', e.target.value)} /></label>
              <label className="check"><input type="checkbox" checked={v.required} onChange={(e) => set('required', e.target.checked)} /> Required for the ITAR</label>
            </div>
          );
        })()}
        <div className="row">
          {edit ? (
            <>
              <button className="btn" disabled={!edit.title.trim()} onClick={saveEdit}>Save</button>
              <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
            </>
          ) : <button className="btn" disabled={!f.title.trim() || !course.data} onClick={add} data-testid="req-add">Add requirement</button>}
        </div>
        <ErrorNote error={err} />
      </div>
    </section>
  );
}

function Retention() {
  const s = useLoad(async () => {
    const { data, error } = await supabase.from('retention_settings').select('*').eq('key', 'itar_evidence_files').single();
    if (error) throw error;
    return data as { retain_days: number | null; note: string; updated_at: string };
  }, []);
  const due = useLoad(() => rpc<any[]>('evidence_due_for_deletion'), []);
  const [days, setDays] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function save() {
    setErr(undefined);
    const v = (days ?? '').trim();
    const { error } = await supabase.from('retention_settings').update({ retain_days: v === '' ? null : Number(v) }).eq('key', 'itar_evidence_files');
    if (error) setErr(error);
    else {
      setDays(null);
      setMsg('Retention period saved.');
      s.reload();
      due.reload();
    }
  }
  async function purge() {
    setConfirm(false);
    setErr(undefined);
    try {
      const n = await deleteEvidenceFiles((due.data ?? []).map((d) => d.id), `Retention policy: ${s.data?.retain_days} days after block end`);
      setMsg(`${n} file(s) deleted. Their records and verification history are kept.`);
      due.reload();
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <section>
      <p className="seclabel">Evidence retention</p>
      {s.loading ? <Spinner /> : (
        <div className="card flat stack">
          <p className="small muted" style={{ margin: 0 }}>{s.data?.note}</p>
          <div className="row">
            <label className="field" style={{ maxWidth: 260 }}>Keep evidence files for (days after the block ends)
              <input type="number" min={0} placeholder="Keep until deleted" value={days ?? (s.data?.retain_days ?? '')} onChange={(e) => setDays(e.target.value)} data-testid="retain-days" />
            </label>
            <button className="btn secondary" disabled={days === null} onClick={save}>Save</button>
          </div>
          <p className="small" style={{ margin: 0 }}>
            Deleting a file keeps the record (who uploaded what, when, its fingerprint and who verified it), so approved ITARs stay traceable. To remove one file
            uploaded in error (e.g. it shows patient information), use <em>Delete file</em> on that case in the resident's ITAR workspace.
          </p>
        </div>
      )}
      <p className="seclabel">Files past the retention period</p>
      {due.loading ? <Spinner /> : !(due.data ?? []).length ? <Empty>No evidence files are due for deletion.</Empty> : (
        <div className="stack">
          <div className="tablewrap">
            <table className="data">
              <thead><tr><th>Resident</th><th>Block</th><th>Block end</th><th>Requirement</th><th>File</th><th>Status</th></tr></thead>
              <tbody>
                {(due.data ?? []).map((d) => (
                  <tr key={d.id}><td>{d.learner}</td><td>{d.block}</td><td>{d.block_end}</td><td>{d.requirement}</td><td className="small">{d.filename}<div className="muted">{fmtDate(d.uploaded_at)}</div></td><td>{d.status}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div><button className="btn danger" onClick={() => setConfirm(true)}>Delete these {(due.data ?? []).length} file(s)</button></div>
        </div>
      )}
      {msg && <div className="notice ok small" role="status" style={{ marginTop: 10 }}>{msg}</div>}
      <ErrorNote error={err} />
      {confirm && (
        <Confirm title="Delete evidence files?" danger confirmLabel="Delete files" onCancel={() => setConfirm(false)} onConfirm={purge}
          body={<p>The files are permanently removed from storage. Records, review history and file fingerprints are kept, and the deletion is audit-logged.</p>} />
      )}
    </section>
  );
}
