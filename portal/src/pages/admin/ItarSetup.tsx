import { useState } from 'react';
import { Page } from '../../components/Layout';
import { Badge, Confirm, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../../components/ui';
import { cohorts as loadCohorts, pocusCourse } from '../../lib/content';
import { deleteEvidenceFiles } from '../../lib/evidence';
import { rpc, supabase } from '../../lib/supabase';
import { NARRATIVE_KEYS, parseTemplate, type IterTemplate } from '../../lib/iter';

type Req = {
  id: string; course_id: string; cohort_id: string | null; kind: string; source: string; title: string; description: string; external_ref: string | null;
  required: boolean; sort: number; archived_at: string | null;
};

/** Admin: what residents must upload per rotation/block, and how long evidence files are kept. */
export function ItarSetup() {
  return (
    <Page kicker="Administration" title="ITAR setup" subtitle="Rotation requirements, scan targets, ITER export layout, learning-case evidence and evidence retention">
      <RotationConfig />
      <IterTemplateConfig />
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

// ---------------------------------------------------------------------------
// Rotation requirements and reviewed-scan targets (per rotation, or per block)
// ---------------------------------------------------------------------------
type RotReq = { id: string; course_id: string; cohort_id: string | null; key: string; kind: string; title: string; description: string; required: boolean;
  resident_submits: boolean; config: Record<string, any>; sort: number; archived_at: string | null };
type ScanCat = { id: string; course_id: string; cohort_id: string | null; key: string; label: string; target: number; views_note: string; sort: number; archived_at: string | null };
const KIND_LABEL: Record<string, string> = { exam: 'Exam (automatic)', learning_cases: 'Brightspace cases (automatic)', epa: 'EPA review (automatic)', scan_log: 'Scan logbook', attestation: 'Faculty-confirmed activity' };
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'item';

function RotationConfig() {
  const course = useLoad(pocusCourse, []);
  const coh = useLoad(loadCohorts, []);
  const reqs = useLoad(async () => {
    const { data, error } = await supabase.from('rotation_requirements').select('*').order('archived_at', { nullsFirst: true }).order('sort');
    if (error) throw error;
    return data as RotReq[];
  }, []);
  const cats = useLoad(async () => {
    const { data, error } = await supabase.from('scan_categories').select('*').order('archived_at', { nullsFirst: true }).order('sort');
    if (error) throw error;
    return data as ScanCat[];
  }, []);
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [nr, setNr] = useState({ title: '', resident_submits: true, cohort_id: '' });
  const [nc, setNc] = useState({ label: '', target: '0', views_note: '', cohort_id: '' });
  const blockName = (id: string | null) => (id ? (coh.data ?? []).find((c: any) => c.id === id)?.name ?? 'block' : 'All blocks');

  async function save(table: 'rotation_requirements' | 'scan_categories', id: string, patch: Record<string, unknown>) {
    setErr(undefined);
    setMsg(null);
    const { error } = await supabase.from(table).update(patch).eq('id', id);
    if (error) setErr(error);
    else {
      setMsg('Saved.');
      table === 'rotation_requirements' ? reqs.reload() : cats.reload();
    }
  }
  async function addReq() {
    setErr(undefined);
    const { error } = await supabase.from('rotation_requirements').insert({
      course_id: course.data!.id, cohort_id: nr.cohort_id || null, key: slug(nr.title), kind: 'attestation', title: nr.title.trim(),
      resident_submits: nr.resident_submits, sort: 100 + (reqs.data?.length ?? 0) * 10,
    });
    if (error) setErr(error);
    else { setNr({ title: '', resident_submits: true, cohort_id: '' }); reqs.reload(); }
  }
  async function addCat() {
    setErr(undefined);
    const { error } = await supabase.from('scan_categories').insert({
      course_id: course.data!.id, cohort_id: nc.cohort_id || null, key: slug(nc.label), label: nc.label.trim(), target: Number(nc.target) || 0,
      views_note: nc.views_note, sort: 100 + (cats.data?.length ?? 0) * 10,
    });
    if (error) setErr(error);
    else { setNc({ label: '', target: '0', views_note: '', cohort_id: '' }); cats.reload(); }
  }

  if (reqs.loading || cats.loading) return <Spinner />;
  return (
    <section style={{ marginBottom: 30 }}>
      <p className="seclabel">Rotation requirements</p>
      <p className="small muted">
        Applies to every block of the rotation, unless a block has its own row with the same key (to change a requirement for one block, add a block-specific one).
        Exam, Brightspace and EPA statuses are calculated automatically; faculty confirm the others.
      </p>
      <div className="tablewrap">
        <table className="data" data-testid="config-requirements">
          <thead><tr><th>Requirement</th><th>Type</th><th>Applies to</th><th>Required</th><th>Resident submits</th><th>Setting</th><th /></tr></thead>
          <tbody>
            {(reqs.data ?? []).map((r) => (
              <tr key={r.id} style={r.archived_at ? { opacity: 0.55 } : undefined}>
                <td><input type="text" defaultValue={r.title} aria-label="Requirement title" style={{ minWidth: 240 }} onBlur={(e) => e.target.value.trim() !== r.title && save('rotation_requirements', r.id, { title: e.target.value.trim() })} /></td>
                <td className="small">{KIND_LABEL[r.kind] ?? r.kind}</td>
                <td className="small">{blockName(r.cohort_id)}</td>
                <td><input type="checkbox" checked={r.required} aria-label="Required" onChange={(e) => save('rotation_requirements', r.id, { required: e.target.checked })} /></td>
                <td>{r.kind === 'attestation' ? <input type="checkbox" checked={r.resident_submits} aria-label="Resident submits" onChange={(e) => save('rotation_requirements', r.id, { resident_submits: e.target.checked })} /> : '—'}</td>
                <td className="small">
                  {r.kind === 'exam' ? (
                    <label>Pass mark % <input type="number" min={0} max={100} defaultValue={r.config?.pass_pct ?? ''} style={{ width: 64 }} data-testid="config-pass-pct"
                      onBlur={(e) => save('rotation_requirements', r.id, { config: { ...r.config, pass_pct: e.target.value === '' ? undefined : Number(e.target.value) } })} /></label>
                  ) : r.kind === 'epa' ? (
                    <div className="stack" style={{ minWidth: 260 }}>
                      <label>Completion criteria (shown to faculty when verifying)
                        <textarea rows={3} defaultValue={r.config?.criteria ?? ''} data-testid="config-epa-criteria"
                          onBlur={(e) => e.target.value !== (r.config?.criteria ?? '') && save('rotation_requirements', r.id, { config: { ...r.config, criteria: e.target.value } })} />
                      </label>
                      <label className="check"><input type="checkbox" checked={r.config?.criteria_status === 'approved'}
                        onChange={(e) => save('rotation_requirements', r.id, { config: { ...r.config, criteria_status: e.target.checked ? 'approved' : 'draft' } })} /> Approved by the rotation director</label>
                    </div>
                  ) : '—'}
                </td>
                <td><button className="btn ghost small" onClick={() => save('rotation_requirements', r.id, { archived_at: r.archived_at ? null : new Date().toISOString() })}>{r.archived_at ? 'Restore' : 'Archive'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: 1, minWidth: 220 }}>New faculty-confirmed activity<input type="text" value={nr.title} onChange={(e) => setNr({ ...nr, title: e.target.value })} placeholder="e.g. Simulation session attended" /></label>
        <label className="field" style={{ maxWidth: 220 }}>Applies to
          <select value={nr.cohort_id} onChange={(e) => setNr({ ...nr, cohort_id: e.target.value })}>
            <option value="">All blocks</option>
            {(coh.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="check small"><input type="checkbox" checked={nr.resident_submits} onChange={(e) => setNr({ ...nr, resident_submits: e.target.checked })} /> Resident can submit</label>
        <button className="btn secondary" disabled={!nr.title.trim() || !course.data} onClick={addReq}>Add</button>
      </div>

      <p className="seclabel" style={{ marginTop: 24 }}>Minimum reviewed-scan targets</p>
      <div className="tablewrap">
        <table className="data" data-testid="config-scans">
          <thead><tr><th>Category</th><th className="num">Target</th><th>Required views (faculty confirm)</th><th>Applies to</th><th /></tr></thead>
          <tbody>
            {(cats.data ?? []).map((c) => (
              <tr key={c.id} style={c.archived_at ? { opacity: 0.55 } : undefined}>
                <td><input type="text" defaultValue={c.label} aria-label="Category" onBlur={(e) => e.target.value.trim() !== c.label && save('scan_categories', c.id, { label: e.target.value.trim() })} /></td>
                <td className="num"><input type="number" min={0} max={1000} defaultValue={c.target} aria-label={`Target for ${c.label}`} style={{ width: 70 }} data-testid={`config-target-${c.key}`}
                  onBlur={(e) => Number(e.target.value) !== c.target && save('scan_categories', c.id, { target: Number(e.target.value) || 0 })} /></td>
                <td><input type="text" defaultValue={c.views_note} aria-label={`Required views for ${c.label}`} style={{ minWidth: 260 }}
                  onBlur={(e) => e.target.value !== c.views_note && save('scan_categories', c.id, { views_note: e.target.value })} /></td>
                <td className="small">{blockName(c.cohort_id)}</td>
                <td><button className="btn ghost small" onClick={() => save('scan_categories', c.id, { archived_at: c.archived_at ? null : new Date().toISOString() })}>{c.archived_at ? 'Restore' : 'Archive'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">Total target: <strong>{(cats.data ?? []).filter((c) => !c.archived_at && !c.cohort_id).reduce((a, c) => a + c.target, 0)}</strong> reviewed scans (rotation-wide rows).</p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field">New category<input type="text" value={nc.label} onChange={(e) => setNc({ ...nc, label: e.target.value })} /></label>
        <label className="field" style={{ maxWidth: 100 }}>Target<input type="number" min={0} value={nc.target} onChange={(e) => setNc({ ...nc, target: e.target.value })} /></label>
        <label className="field" style={{ flex: 1 }}>Required views<input type="text" value={nc.views_note} onChange={(e) => setNc({ ...nc, views_note: e.target.value })} /></label>
        <label className="field" style={{ maxWidth: 200 }}>Applies to
          <select value={nc.cohort_id} onChange={(e) => setNc({ ...nc, cohort_id: e.target.value })}>
            <option value="">All blocks</option>
            {(coh.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button className="btn secondary" disabled={!nc.label.trim() || !course.data} onClick={addCat}>Add</button>
      </div>
      {msg && <p className="small" role="status">{msg}</p>}
      <ErrorNote error={err} />
    </section>
  );
}

type TplRow = { id: string; course_id: string | null; name: string; status: 'draft' | 'confirmed'; definition: unknown; confirmed_at: string | null; updated_at: string };

/** Admin: the ITER export layout (headings, options and where each section goes in Elentra). */
function IterTemplateConfig() {
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('iter_templates').select('*').order('course_id', { nullsFirst: false });
    if (error) throw error;
    return data as TplRow[];
  }, []);
  const row = list.data?.[0] ?? null;
  return (
    <section style={{ marginBottom: 30 }}>
      <h2>ITER export template</h2>
      <p className="small muted">
        Controls the headings, options and Elentra destinations of the ITER-ready summary. It never adds ratings or the outcome. The seeded layout is based on an elective ITER
        example — the rotation director should confirm it matches the current POCUS block ITER.
      </p>
      {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorNote error={list.error} /> : !row ? <Empty>No template configured.</Empty>
        : <TemplateEditor key={`${row.id}-${row.updated_at}`} row={row} reload={list.reload} />}
    </section>
  );
}

function TemplateEditor({ row, reload }: { row: TplRow; reload: () => void }) {
  const [name, setName] = useState(row.name);
  const [t, setT] = useState<IterTemplate>(() => parseTemplate(row.definition));
  const [confirmed, setConfirmed] = useState(row.status === 'confirmed');
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  async function save() {
    setBusy(true);
    setErr(undefined);
    setMsg(null);
    const { error } = await supabase.from('iter_templates').update({ name: name.trim(), definition: t, status: confirmed ? 'confirmed' : 'draft' }).eq('id', row.id);
    setBusy(false);
    if (error) setErr(error);
    else { setMsg('Template saved. New ITER-ready summaries use it; approved versions keep the layout they were approved with.'); reload(); }
  }
  const field = (label: string, value: string, set: (v: string) => void, testid?: string) => (
    <label className="field">{label}<input type="text" value={value} onChange={(e) => set(e.target.value)} data-testid={testid} /></label>
  );

  return (
    <div className="panel stack" data-testid="iter-template-editor">
      <div className="row between">
        <div>{row.status === 'confirmed' ? <Badge tone="ok">confirmed {fmtDate(row.confirmed_at)}</Badge> : <Badge tone="warn">draft — pending rotation director confirmation</Badge>}</div>
      </div>
      <div className="formgrid">
        {field('Template name', name, setName)}
        {field('Form name', t.form_name, (v) => setT({ ...t, form_name: v }))}
      </div>
      <label className="field">Based on / note<textarea rows={2} value={t.based_on} onChange={(e) => setT({ ...t, based_on: e.target.value })} /></label>
      <div className="formgrid">
        {field('Evidence section heading', t.evidence.heading, (v) => setT({ ...t, evidence: { ...t.evidence, heading: v } }))}
        {field('Evidence → where to paste', t.evidence.destination, (v) => setT({ ...t, evidence: { ...t.evidence, destination: v } }))}
      </div>
      <div className="formgrid">
        {field('Rotation objectives heading', t.outcome.heading, (v) => setT({ ...t, outcome: { ...t.outcome, heading: v } }))}
        <label className="field">Rotation objectives options <span className="hint">one per line, as on the form</span>
          <textarea rows={5} value={t.outcome.options.join('\n')} onChange={(e) => setT({ ...t, outcome: { ...t.outcome, options: lines(e.target.value) } })} data-testid="tpl-outcome-options" /></label>
      </div>
      <strong className="small">Narrative fields</strong>
      {NARRATIVE_KEYS.map((k) => (
        <div key={k} className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>{field(`Heading (${k})`, t.narrative[k].heading, (v) => setT({ ...t, narrative: { ...t.narrative, [k]: { ...t.narrative[k], heading: v } } }))}</div>
          <label className="check small"><input type="checkbox" checked={t.narrative[k].required} onChange={(e) => setT({ ...t, narrative: { ...t.narrative, [k]: { ...t.narrative[k], required: e.target.checked } } })} /> required before approval</label>
        </div>
      ))}
      <div className="formgrid">
        {field('Basis of assessment heading', t.basis.heading, (v) => setT({ ...t, basis: { ...t.basis, heading: v } }))}
        <label className="field">Basis options <span className="hint">one per line</span>
          <textarea rows={6} value={t.basis.options.join('\n')} onChange={(e) => setT({ ...t, basis: { ...t.basis, options: lines(e.target.value) } })} /></label>
        {field('Discussed-with-trainee heading', t.discussed.heading, (v) => setT({ ...t, discussed: { ...t.discussed, heading: v } }))}
      </div>
      <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="tpl-confirmed" />{' '}
        The rotation director confirmed this layout matches the current POCUS block ITER.</label>
      <div className="row">
        <button className="btn small" disabled={busy || !name.trim() || !t.outcome.options.length} onClick={save} data-testid="tpl-save">Save template</button>
        <span className="small muted">Editing a confirmed template returns it to draft unless you confirm again.</span>
      </div>
      {msg && <div className="notice ok small" role="status">{msg}</div>}
      <ErrorNote error={err} />
    </div>
  );
}
