import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { EvidencePreview } from '../../components/EvidencePreview';
import { Badge, Confirm, DomainBars, Empty, ErrorNote, Spinner, fmtDate, pct, useLoad } from '../../components/ui';
import { isAdmin, useAuth } from '../../lib/auth';
import { download, toCSV } from '../../lib/csv';
import { deleteEvidenceFiles } from '../../lib/evidence';
import {
  CATEGORIES, CRITERIA_LABEL, epaVerified, STATUS_LABEL, TONE, chooseAttempt, composeSummary, draftItar, factsFrom, fingerprint, latestSubmission, outstanding,
  requirementState, type AttemptRule, type EpaEntry, type EpaReview, type ItarInput, type ItarSection, type Observation, type OverviewRow,
  type Requirement, type WsAttempt,
} from '../../lib/itar';
import {
  REQ_LABEL, REQ_TONE, completion, rotationPassPct, scanDeltas, scanPct, withSelectedAttempt, type ReqStatus, type Rotation, type RotationReq,
} from '../../lib/requirements';
import {
  NEEDS_FACULTY, QUICK_KINDS, applyFaculty, basisHints, composeIter, draftIter, entrustmentText, evidenceSections, isIterDraft, parseTemplate, quickDrafts,
  quickSections, refreshDrafts, type IterFields, type NarrativeKey,
} from '../../lib/iter';
import { openRequirements, residentTasks, type RotRow } from '../../lib/overview';
import { rpc, supabase } from '../../lib/supabase';

type Cohort = { id: string; course_id: string; course: string; name: string; block_label: string | null; academic_year: string | null; start_date: string | null; end_date: string | null };
type EvalRow = {
  id: string; status: 'draft' | 'approved'; attempt_id: string | null; attempt_rule: AttemptRule; itar_sections: ItarSection[]; summary: string;
  strengths: string; areas_for_improvement: string; observations: string; evidence_snapshot: any; generated_at: string | null;
  approved_at: string | null; approved_by_name: string | null; updated_at: string; iter_fields?: IterFields;
};
type Ws = {
  me: string;
  learner: { id: string; full_name: string; email: string; training_level: string | null; program: string | null };
  cohort: Cohort;
  requirements: Requirement[];
  exam_assigned: boolean;
  attempts: WsAttempt[];
  epa_review: (EpaReview & { id: string; updated_at: string; updated_by_name: string | null }) | null;
  observations: (Observation & { cohort_id: string | null; author_id: string })[];
  evaluation: EvalRow | null;
  roster: { id: string; name: string }[];
};


const today = () => new Date().toLocaleDateString('en-CA');

/** Fallback copy through a hidden, selected textarea (works where navigator.clipboard is blocked). */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
const dates = (c: { start_date: string | null; end_date: string | null }) => (c.start_date || c.end_date ? `${c.start_date ?? '—'} → ${c.end_date ?? '—'}` : 'Block dates not set');

// ---------------------------------------------------------------------------
// Blocks list (Faculty dashboard) and block overview (cohort dashboard)
// ---------------------------------------------------------------------------
export function BlocksPanel() {
  const b = useLoad(() => rpc<any[]>('itar_blocks'), []);
  if (b.loading) return <Spinner />;
  if (b.error) return <ErrorNote error={b.error} />;
  const list = (b.data ?? []).filter((x) => !x.archived);
  if (!list.length) return <Empty>No rotation blocks yet. Faculty see blocks where they are an evaluator (Admin → People → Cohorts).</Empty>;
  return (
    <div className="grid">
      {list.map((x) => (
        <Link key={x.id} to={`/faculty/blocks/${x.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit', ['--accent' as any]: 'var(--moss)' }} data-testid="block-card">
          <p className="kicker" style={{ marginBottom: 4 }}>{x.course}</p>
          <h3>{x.name}</h3>
          <p className="small muted" style={{ margin: '0 0 10px' }}>{dates(x)}</p>
          <div className="stats">
            <div className="stat"><b>{x.n_residents}</b><span>residents</span></div>
            <div className="stat"><b>{x.n_approved}/{x.n_residents}</b><span>Drafts approved · ready for One45</span></div>
          </div>
        </Link>
      ))}
    </div>
  );
}

export function BlockOverview() {
  const { cohortId = '' } = useParams();
  const nav = useNavigate();
  const d = useLoad(() => rpc<{ cohort: Cohort; residents: OverviewRow[] }>('itar_block_overview', { p_cohort: cohortId }), [cohortId]);
  const rq = useLoad(() => rpc<RotRow[]>('rotation_block_overview', { p_cohort: cohortId }), [cohortId]);
  const [onlyOpen, setOnlyOpen] = useState(false);
  if ((d.loading && !d.data) || (rq.loading && !rq.data && !rq.error)) return <Spinner />;
  if (d.error) return <div className="wrap"><ErrorNote error={d.error} /></div>;
  const { cohort, residents } = d.data!;
  const rotBy = new Map((rq.data ?? []).map((x) => [x.learner_id, x]));
  const rows = residents.map((r) => {
    const x = rotBy.get(r.id) ?? null;
    return { r, x, t: residentTasks(r, x), open: openRequirements(x) };
  });
  const n = residents.length;
  const count = (f: (r: OverviewRow) => boolean) => residents.filter(f).length;

  function exportCsv() {
    download(`${cohort.name.replace(/\W+/g, '_')}_ITER_status.csv`, toCSV(rows.map(({ r, x, t, open }) => ({
      resident: r.name, training_level: r.training_level ?? '',
      requirements_complete: t.completion ? `${t.completion.done}/${t.completion.total}` : '', requirements_open: open.join('; '),
      scans_verified: x ? `${x.scans.verified_total}/${x.scans.target_total}` : '',
      exam: r.exam.latest ? `${r.exam.latest.score_pct ?? ''}%` : 'outstanding',
      epa: (x?.requirements.find((q) => q.kind === 'epa')?.extra?.criteria_status as string | undefined) ?? r.epa_status,
      evidence_verified: `${r.evidence.verified}/${r.evidence.required}`, evidence_awaiting_review: r.evidence.awaiting_review,
      iter: r.itar?.status === 'approved' ? 'draft approved — ready for One45' : r.itar ? 'draft' : 'not started',
      faculty_tasks: t.faculty.map((f) => f.label).join('; '), resident_tasks: t.resident.join('; '),
    }))));
  }

  return (
    <Page kicker={`ITER preparation · ${cohort.course}`} title={cohort.name} subtitle={dates(cohort)}
      actions={<><Link className="btn secondary" to="/faculty">← Dashboard</Link><button className="btn secondary" onClick={exportCsv}>Export CSV</button><button className="btn secondary" onClick={() => window.print()}>Print</button></>}>
      <section className="card flat" style={{ marginBottom: 18 }}>
        <div className="stats">
          <div className="stat"><b>{n}</b><span>residents</span></div>
          {rq.data && <div className="stat"><b>{rows.filter((x) => x.t.completion && x.t.completion.outstanding === 0).length}/{n}</b><span>requirements complete</span></div>}
          <div className="stat"><b>{count((r) => !!r.exam.latest)}/{n}</b><span>exams submitted</span></div>
          <div className="stat"><b>{rq.data ? rows.filter((x) => x.x?.requirements.find((q) => q.kind === 'epa')?.status === 'verified').length : count((r) => r.epa_status === 'complete')}/{n}</b><span>EPA criteria met</span></div>
          <div className="stat"><b>{count((r) => r.itar?.status === 'approved')}/{n}</b><span>Drafts approved · ready for One45</span></div>
        </div>
      </section>
      <div className="row between no-print" style={{ marginBottom: 10 }}>
        <label className="check"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only residents needing attention</label>
        <span className="small muted">Click a row to open the resident's workspace.</span>
      </div>
      {!n && <Empty>No residents in this block yet.</Empty>}
      {n > 0 && (
        <div className="tablewrap">
          <table className="data stackable" data-testid="block-overview">
            <thead><tr><th>Resident</th><th>Requirements</th><th>Scans</th><th>Exam</th><th>EPA</th><th>ITER</th><th>To do</th></tr></thead>
            <tbody>
              {rows.filter(({ t }) => !onlyOpen || !t.done).map(({ r, x, t, open }) => (
                <tr key={r.id} className="clickable" onClick={() => nav(`/faculty/itar/${cohortId}/${r.id}`)} data-testid="overview-row">
                  <td data-label="Resident"><Link to={`/faculty/itar/${cohortId}/${r.id}`} onClick={(e) => e.stopPropagation()}><strong>{r.name}</strong></Link>
                    {r.training_level && <span className="small muted"> · {r.training_level}</span>}</td>
                  <td data-label="Requirements">
                    {t.completion ? <><strong>{t.completion.done}/{t.completion.total}</strong>{' '}
                      {t.completion.outstanding === 0 ? <Badge tone="ok">{t.completion.notYetDue ? 'up to date' : 'complete'}</Badge> : <span className="small muted">{t.completion.outstanding} open</span>}</> : '—'}
                  </td>
                  <td data-label="Scans" className="nowrap">
                    {x ? <><span className="small"><strong>{x.scans.verified_total}</strong>/{x.scans.target_total}</span>
                      <div className="bar" aria-hidden style={{ maxWidth: 90 }}><span style={{ width: `${x.scans.target_total ? Math.min(100, (100 * x.scans.verified_total) / x.scans.target_total) : 0}%` }} /></div></> : '—'}
                  </td>
                  <td data-label="Exam" className="nowrap">
                    {r.exam.latest ? (
                      <>
                        <strong>{r.exam.latest.score_pct != null ? pct(r.exam.latest.score_pct, 0) : '—'}</strong>{' '}
                        {(() => {
                          const ex = x?.requirements.find((q) => q.kind === 'exam');
                          const pp = ex?.extra?.pass_pct;
                          if (r.exam.latest.grading_status === 'pending_manual') return <Badge tone="warn">needs grading</Badge>;
                          if (ex && pp != null && r.exam.latest.score_pct != null) return ex.status === 'verified' ? <Badge tone="ok">≥ {Math.round(Number(pp))}%</Badge> : <Badge tone="bad">below {Math.round(Number(pp))}%</Badge>;
                          return r.exam.latest.passed == null ? null : r.exam.latest.passed ? <Badge tone="ok">pass</Badge> : <Badge tone="bad">below</Badge>;
                        })()}
                      </>
                    ) : <span className="small muted">{r.exam.in_progress ? 'in progress' : r.exam.assigned ? 'not taken' : 'not assigned'}</span>}
                  </td>
                  <td data-label="EPA">
                    {(() => {
                      const q = x?.requirements.find((y) => y.kind === 'epa');
                      const cs = q?.extra?.criteria_status as string | undefined;
                      const b = q?.status === 'not_applicable' || q?.status === 'not_yet_due' ? <Badge>{REQ_LABEL[q.status]}</Badge>
                        : cs === 'met' ? <Badge tone="ok">criteria met</Badge>
                        : cs === 'partially_met' ? <Badge tone="warn">partially met</Badge>
                        : cs === 'outstanding' ? <Badge tone="bad">not met</Badge>
                        : <Badge>{r.epa_status === 'complete' ? 're-verify' : 'pending'}</Badge>;
                      return <>{b}{q?.extra?.has_concerns && <> <Badge tone="bad">concern</Badge></>}</>;
                    })()}
                  </td>
                  <td data-label="ITER">
                    {!r.itar ? <Badge>not started</Badge> : r.itar.status === 'approved' ? <Badge tone="ok">draft approved — ready for One45</Badge> : <Badge tone="warn">draft</Badge>}
                    {(x?.itar?.changes_since_approval.length ?? 0) > 0 && <> <Badge tone="warn">new evidence since draft approval</Badge></>}
                  </td>
                  <td data-label="To do" className="small" onClick={(e) => e.stopPropagation()}>
                    {t.done ? <span className="muted">No action needed</span> : (
                      <>
                      <div className="print-only">{[t.faculty.length ? `You: ${t.faculty.map((f) => f.label).join('; ')}` : '', t.resident.length ? `Resident: ${t.resident.join('; ')}` : ''].filter(Boolean).join(' — ')}</div>
                      <details className="todo no-print" data-testid="overview-todo">
                        <summary>
                          {t.faculty.length > 0 && <Badge tone="warn">You: {t.faculty.length}</Badge>}{' '}
                          {t.resident.length > 0 && <Badge>Resident: {t.resident.length}</Badge>}
                        </summary>
                        {t.faculty.length > 0 && <div><strong>You:</strong> {t.faculty.map((f, i) => <span key={f.label}>{i > 0 && ' · '}<Link to={`/faculty/itar/${cohortId}/${r.id}${f.anchor}`}>{f.label}</Link></span>)}</div>}
                        {t.resident.length > 0 && <div className="muted">Resident: {t.resident.join(' · ')}</div>}
                        {open.length > 0 && <div className="muted">Open requirements: {open.join(', ')}</div>}
                      </details>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

/** Faculty dashboard: what needs the faculty member's attention, across their blocks. */
export function FacultyTasks() {
  const blocks = useLoad(() => rpc<any[]>('itar_blocks'), []);
  const data = useLoad(async () => {
    const list = (blocks.data ?? []).filter((b) => !b.archived);
    return Promise.all(list.map(async (b) => {
      const [o, rot] = await Promise.all([
        rpc<{ cohort: Cohort; residents: OverviewRow[] }>('itar_block_overview', { p_cohort: b.id }),
        rpc<RotRow[]>('rotation_block_overview', { p_cohort: b.id }).catch(() => [] as RotRow[]),
      ]);
      const by = new Map(rot.map((x) => [x.learner_id, x]));
      return { block: b, rows: o.residents.map((r) => ({ r, t: residentTasks(r, by.get(r.id)) })) };
    }));
  }, [blocks.data]);
  if (blocks.loading || (data.loading && !data.data)) return <Spinner />;
  const err = blocks.error ?? data.error;
  if (err) return <ErrorNote error={err} />;
  const items = (data.data ?? []).flatMap(({ block, rows }) => rows.filter(({ t }) => t.faculty.length).map(({ r, t }) => ({ block, r, t })));
  const total = items.reduce((a, x) => a + x.t.faculty.length, 0);
  return (
    <section className="card" style={{ ['--accent' as any]: 'var(--clay)', marginBottom: 18 }} data-testid="faculty-tasks">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Needs your attention</h3>
        {total > 0 && <Badge tone="warn">{total} task{total === 1 ? '' : 's'} · {items.length} resident{items.length === 1 ? '' : 's'}</Badge>}
      </div>
      {!items.length ? <p className="small muted">Nothing waiting for you in your rotation blocks.</p> : (
        <ul className="tasklist">
          {items.map(({ block, r, t }) => (
            <li key={`${block.id}-${r.id}`} data-testid="faculty-task">
              <Link to={`/faculty/itar/${block.id}/${r.id}`}><strong>{r.name}</strong></Link> <span className="small muted">· {block.name}</span>
              <div className="chips" style={{ marginTop: 4 }}>
                {t.faculty.map((f) => <Link key={f.label} className="chip" to={`/faculty/itar/${block.id}/${r.id}${f.anchor}`}>{f.label}</Link>)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Resident ITAR workspace
// ---------------------------------------------------------------------------
export function ItarWorkspace() {
  const { cohortId = '', learnerId = '' } = useParams();
  const ws = useLoad(() => rpc<Ws>('itar_workspace', { p_learner: learnerId, p_cohort: cohortId }), [cohortId, learnerId]);
  const rot = useLoad(() => rpc<Rotation>('rotation_status', { p_learner: learnerId, p_cohort: cohortId }), [cohortId, learnerId]);
  const tpl = useLoad(() => rpc<TemplateRow | null>('iter_template_for', { p_cohort: cohortId }).catch(() => null), [cohortId]);
  const [sel, setSel] = useState<{ key: string; id: string | null } | null>(null);
  const loc = useLocation();
  const ready = !!ws.data && tpl.data !== undefined;
  // deep links from the dashboard / overview (e.g. #cases, #scans, #itar) once the page has rendered
  useEffect(() => {
    if (!ready || !loc.hash) return;
    const t = setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'start' }), 60);
    return () => clearTimeout(t);
  }, [ready, loc.hash, learnerId]);
  if ((ws.loading && !ws.data) || (rot.loading && !rot.data && !rot.error) || (tpl.loading && tpl.data === undefined)) return <Spinner />;
  if (ws.error) return <div className="wrap"><ErrorNote error={ws.error} /></div>;
  const w = ws.data!;
  const reload = () => { ws.reload(); rot.reload(); };
  // quick actions return requirement status only; keep the ITAR state and refresh it in the background
  const setRot = (r: Rotation) => { rot.setData({ ...r, itar: r.itar ?? rot.data?.itar ?? null }); rot.reload(); };
  const rc = rot.data ? completion(rot.data.requirements) : null;
  const ev = w.evaluation;
  const locked = ev?.status === 'approved';
  const selected = sel && sel.key === `${cohortId}/${learnerId}` ? sel.id : ev?.attempt_rule === 'faculty_selected' ? ev.attempt_id : null;
  const name = w.learner.full_name || w.learner.email;
  const idx = w.roster.findIndex((r) => r.id === learnerId);
  const prev = idx > 0 ? w.roster[idx - 1] : null;
  const next = idx >= 0 && idx < w.roster.length - 1 ? w.roster[idx + 1] : null;
  const blockObs = w.observations.filter((o) => o.cohort_id === cohortId);
  const req = w.requirements.filter((r) => r.required);
  const nVerified = req.filter((r) => requirementState(r) === 'verified').length;
  const chosen = chooseAttempt(w.attempts, selected);

  const steps = [
    ...(rc ? [{ id: 'requirements', label: 'Requirements', ok: rc.outstanding === 0, detail: `${rc.done}/${rc.total} complete${rc.notYetDue ? ` · ${rc.notYetDue} not yet due` : ''}` }] : []),
    { id: 'exam', label: 'A · Exam', ok: !!chosen.attempt && chosen.attempt.grading_status === 'complete', detail: chosen.attempt?.score_pct != null ? pct(chosen.attempt.score_pct, 1) : w.exam_assigned ? 'outstanding' : 'none assigned' },
    { id: 'cases', label: 'B · Learning cases', ok: req.length > 0 && nVerified === req.length, detail: `${nVerified}/${req.length} verified` },
    { id: 'epa', label: 'C · EPA review', ok: epaVerified(w.epa_review) && w.epa_review!.criteria_status === 'met', detail: epaVerified(w.epa_review) ? `criteria ${CRITERIA_LABEL[w.epa_review!.criteria_status!]}` : w.epa_review?.status === 'complete' ? 're-verify' : 'pending' },
    { id: 'observations', label: 'D · Observations', ok: blockObs.length > 0, detail: `${blockObs.length} recorded` },
    { id: 'itar', label: tpl.data ? 'E · ITER summary' : 'E · ITAR draft', ok: locked, detail: locked ? 'draft approved — ready for One45' : ev ? 'draft' : 'not started' },
  ];

  return (
    <Page kicker={`ITAR preparation · ${w.cohort.course} · ${w.cohort.name}`} title={name}
      subtitle={<>{[w.learner.training_level, w.learner.program].filter(Boolean).join(' · ')} · {dates(w.cohort)}</>}
      actions={<>
        <Link className="btn secondary" to={`/faculty/blocks/${cohortId}`}>← Block</Link>
        {prev && <Link className="btn secondary" to={`/faculty/itar/${cohortId}/${prev.id}`} title={prev.name}>‹ Previous</Link>}
        {next && <Link className="btn secondary" to={`/faculty/itar/${cohortId}/${next.id}`} title={next.name} data-testid="next-resident">Next ›</Link>}
      </>}>
      <div className="no-print">
        <div className="notice small" style={{ marginBottom: 14 }}>
          This workspace <strong>prepares</strong> a draft from evidence in the portal. The official ITER is completed and submitted by faculty in <strong>One45</strong>;
          C6 EPA assessments stay in Elentra. The portal assigns no rating, never infers scanning, clinical or technical skill from exam scores, and submits nothing.
        </div>
        <nav className="checklist" aria-label="Evidence checklist">
          {steps.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={s.ok ? 'done' : ''}>
              <span aria-hidden>{s.ok ? '✓' : '○'}</span> <strong>{s.label}</strong> <span className="muted">{s.detail}</span>
            </a>
          ))}
        </nav>
        {rot.error ? <ErrorNote error={rot.error} /> : rot.data && <RequirementsSection w={w} rot={rot.data} reload={reload} setRot={setRot} />}
        <ExamSection w={w} chosen={chosen} locked={locked} passPct={rotationPassPct(rot.data)} onSelect={(id) => setSel({ key: `${cohortId}/${learnerId}`, id })} />
        <CasesSection w={w} reload={reload} />
        <EpaSection key={`${learnerId}-${w.epa_review?.updated_at ?? 'new'}`} w={w} reload={reload} />
        <ObservationsSection w={w} reload={reload} locked={locked} />
      </div>
      <DraftSection key={`${learnerId}-${ev?.id ?? 'new'}-${ev?.updated_at ?? ''}`} w={w} reload={reload} selectedAttempt={selected} rotation={rot.data ?? null} template={tpl.data ?? null} />
    </Page>
  );
}

function SectionHead({ id, letter, title, children }: { id: string; letter: string; title: string; children?: ReactNode }) {
  return (
    <div className="row between" style={{ margin: '34px 0 12px' }} id={id}>
      <h2 style={{ margin: 0 }}><span className="kicker" style={{ display: 'inline', marginRight: 8 }}>{letter}</span>{title}</h2>
      <div className="row">{children}</div>
    </div>
  );
}

function ExamSection({ w, chosen, locked, passPct, onSelect }: { w: Ws; chosen: ReturnType<typeof chooseAttempt>; locked: boolean; passPct: number | null; onSelect: (id: string | null) => void }) {
  const a = chosen.attempt;
  const facts = factsFrom(a);
  return (
    <section>
      <SectionHead id="exam" letter="A" title="Examination performance" />
      {!w.attempts.length ? (
        <Empty>{w.exam_assigned ? 'The resident has not started the end-of-block examination.' : 'No end-of-block examination is assigned to this block or resident.'}</Empty>
      ) : (
        <div className="split">
          <div className="tablewrap">
            <table className="data">
              <thead><tr><th>Used for ITAR</th><th>Exam</th><th>Status</th><th>Submitted</th><th className="num">Score</th><th>Result</th><th /></tr></thead>
              <tbody>
                {w.attempts.map((x) => (
                  <tr key={x.id}>
                    <td>
                      {x.status === 'submitted' && (
                        <input type="radio" name="itar-attempt" checked={a?.id === x.id} disabled={locked} onChange={() => onSelect(x.id)}
                          aria-label={`Use attempt ${x.attempt_no} for the ITAR`} />
                      )}
                    </td>
                    <td>{x.exam_title} <span className="small muted">v{x.version} · attempt {x.attempt_no}</span></td>
                    <td>{x.status === 'in_progress' ? <Badge tone="warn">in progress</Badge> : x.grading_status === 'pending_manual' ? <Badge tone="warn">needs grading</Badge> : <Badge tone="ok">submitted</Badge>}</td>
                    <td className="small">{fmtDate(x.submitted_at)}</td>
                    <td className="num">{x.score_pct != null ? pct(x.score_pct, 1) : '—'}</td>
                    <td>{x.passed == null ? '—' : x.passed ? <Badge tone="ok">pass</Badge> : <Badge tone="bad">below</Badge>}</td>
                    <td><Link className="btn ghost small" to={`/faculty/attempts/${x.id}`}>Review</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <aside className="card flat">
            {!facts ? <p className="small muted">No submitted attempt yet.</p> : (
              <>
                <p className="small" style={{ marginTop: 0 }}>
                  <strong>Used for this ITAR:</strong> attempt {facts.attemptNo}, {fmtDate(facts.submittedAt)}
                  <br /><span className="muted">{chosen.rule === 'faculty_selected' ? 'Selected by faculty.' : 'Rule: most recent submitted attempt (choose another on the left).'}</span>
                </p>
                <div className="stats">
                  <div className="stat"><b>{facts.scorePct != null ? pct(facts.scorePct, 1) : '—'}</b><span>score</span></div>
                  {passPct != null && facts.scorePct != null ? (
                    <div className="stat" data-testid="rotation-pass"><b>{facts.scorePct >= passPct ? 'Met' : 'Below'}</b><span>rotation pass mark {pct(passPct)}</span></div>
                  ) : facts.passThresholdPct != null && <div className="stat"><b>{facts.passed == null ? '—' : facts.passed ? 'Pass' : 'Below'}</b><span>threshold {pct(facts.passThresholdPct)}</span></div>}
                </div>
                <DomainBars domains={facts.domains} />
                <p className="small muted" style={{ marginBottom: 0 }}>Knowledge assessment only.</p>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function CasesSection({ w, reload }: { w: Ws; reload: () => void }) {
  const req = w.requirements;
  const verified = req.filter((r) => r.required && requirementState(r) === 'verified').length;
  return (
    <section>
      <SectionHead id="cases" letter="B" title="Learning-case completion (Brightspace)">
        <span className="small"><strong>{verified}/{req.filter((r) => r.required).length}</strong> required verified</span>
      </SectionHead>
      {!req.length && <Empty>No learning-case requirements are configured (Admin → ITAR setup).</Empty>}
      <div className="stack">{req.map((r) => <EvidenceRow key={r.id} r={r} w={w} reload={reload} />)}</div>
    </section>
  );
}

function EvidenceRow({ r, w, reload }: { r: Requirement; w: Ws; reload: () => void }) {
  const state = requirementState(r);
  const last = latestSubmission(r);
  const [view, setView] = useState<{ path: string; mime: string; name: string } | null>(null);
  const [mode, setMode] = useState<'clarification_requested' | 'rejected' | 'delete' | null>(null);
  const [message, setMessage] = useState('');
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const { profile } = useAuth();

  async function removeFile() {
    if (!last) return;
    setBusy(true);
    setErr(undefined);
    try {
      await deleteEvidenceFiles([last.id], message);
      setMode(null);
      setMessage('');
      reload();
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  }

  async function decide(status: 'verified' | 'clarification_requested' | 'rejected') {
    if (!last) return;
    setBusy(true);
    setErr(undefined);
    try {
      await rpc('review_evidence', { p_id: last.id, p_status: status, p_message: status === 'verified' ? '' : message });
      setMode(null);
      setMessage('');
      reload();
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  }

  return (
    <div className="panel" data-testid="evidence-row">
      <div className="row between">
        <div><strong>{r.title}</strong>{!r.required && <span className="small muted"> · optional</span>}</div>
        <Badge tone={TONE[state]}>{STATUS_LABEL[state]}</Badge>
      </div>
      {!last ? <p className="small muted" style={{ margin: '6px 0 0' }}>The resident has not uploaded evidence for this case.</p> : (
        <div className="small" style={{ marginTop: 6 }}>
          {last.file_deleted_at ? <span className="muted">{last.original_filename} — file removed under the retention policy</span> : (
            <button className="btn secondary small" onClick={() => setView({ path: last.storage_path, mime: last.mime_type, name: last.original_filename })} data-testid="preview-evidence">
              Preview {last.mime_type === 'application/pdf' ? 'PDF' : 'image'}
            </button>
          )}{' '}
          <span className="muted">{last.original_filename} · uploaded {fmtDate(last.created_at)}</span>
          {last.learner_note && <div style={{ marginTop: 4 }}>Resident's note: “{last.learner_note}”</div>}
          {last.reviewed_at && <div className="muted" style={{ marginTop: 4 }}>{STATUS_LABEL[last.status]} by {last.reviewer_name ?? 'faculty'} · {fmtDate(last.reviewed_at)}{last.reviewer_message ? ` — “${last.reviewer_message}”` : ''}</div>}
          {!last.file_deleted_at && w.me !== w.learner.id && (
            <div className="row" style={{ marginTop: 10 }}>
              {last.status !== 'verified' && <button className="btn small" disabled={busy} onClick={() => decide('verified')} data-testid="verify-evidence">Verify</button>}
              <button className="btn secondary small" disabled={busy} onClick={() => setMode('clarification_requested')}>Needs clarification…</button>
              <button className="btn secondary small" disabled={busy} onClick={() => setMode('rejected')}>Reject…</button>
              {isAdmin(profile) && <button className="btn ghost small" disabled={busy} onClick={() => setMode('delete')}>Delete file…</button>}
            </div>
          )}
          {mode && (
            <div className="stack" style={{ marginTop: 10 }}>
              <label className="field">{mode === 'delete' ? 'Reason for deleting the file' : 'Message to the resident'}{' '}
                <span className="hint">{mode === 'delete' ? 'audit-logged; e.g. “contains patient information”. The record is kept.' : 'they will see this next to the case'}</span>
                <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} data-testid="evidence-message" />
              </label>
              <div className="row">
                {mode === 'delete'
                  ? <button className="btn danger small" disabled={busy || !message.trim()} onClick={removeFile}>Delete file permanently</button>
                  : <button className="btn small" disabled={busy || !message.trim()} onClick={() => decide(mode)}>{mode === 'rejected' ? 'Reject' : 'Request clarification'}</button>}
                <button className="btn ghost small" onClick={() => setMode(null)}>Cancel</button>
              </div>
            </div>
          )}
          {r.submissions.length > 1 && (
            <details className="disclosure" style={{ marginTop: 8 }}>
              <summary>Earlier uploads ({r.submissions.length - 1})</summary>
              <ul>
                {r.submissions.slice(1).map((s) => (
                  <li key={s.id}>
                    {s.file_deleted_at ? s.original_filename : <button className="btn ghost small" onClick={() => setView({ path: s.storage_path, mime: s.mime_type, name: s.original_filename })}>{s.original_filename}</button>}
                    {' '}· {fmtDate(s.created_at)} · {STATUS_LABEL[s.status]}{s.reviewer_message ? ` — “${s.reviewer_message}”` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <ErrorNote error={err} />
      {view && (
        <EvidencePreview {...view} onClose={() => setView(null)}
          actions={last && view.path === last.storage_path && last.status !== 'verified' && !last.file_deleted_at && w.me !== w.learner.id
            ? <button className="btn small" disabled={busy} data-testid="verify-in-preview" onClick={async () => { await decide('verified'); setView(null); }}>Verify</button>
            : undefined} />
      )}
    </div>
  );
}

const LEVELS = ['5', '4', '3', '2', '1'];
const blankEntry = (): EpaEntry => ({ epa: '', title: '', n_assessments: null, entrustment: '', comment: '' });

function EpaSection({ w, reload }: { w: Ws; reload: () => void }) {
  const r = w.epa_review;
  const verified = epaVerified(r);
  const legacy = r?.status === 'complete' && !r.criteria_status;
  const crit = useLoad(async () => {
    const { data } = await supabase.from('rotation_requirements').select('config, cohort_id').eq('kind', 'epa').is('archived_at', null);
    const rows = (data ?? []).filter((x: any) => !x.cohort_id || x.cohort_id === w.cohort.id).sort((a: any, b: any) => (a.cohort_id ? 0 : 1) - (b.cohort_id ? 0 : 1));
    const c = rows[0]?.config ?? {};
    return { text: String(c.criteria ?? ''), approved: c.criteria_status === 'approved' };
  }, [w.cohort.id]);
  const [editing, setEditing] = useState(!verified);
  const [f, setF] = useState(() => ({
    reviewed: false, decision: (r?.criteria_status ?? '') as '' | 'met' | 'partially_met' | 'outstanding', confirmed: false,
    strengths: r?.strengths ?? '', areas: r?.areas_for_improvement ?? '', concerns: r?.concerns ?? '',
    n: r?.assessments_reviewed == null ? '' : String(r.assessments_reviewed), findings: r?.key_findings ?? '',
    counts: Object.fromEntries(LEVELS.map((l) => [l, r?.entrustment_counts?.[l] ? String(r.entrustment_counts[l]) : ''])) as Record<string, string>,
  }));
  const countSum = LEVELS.reduce((a, l) => a + (Number(f.counts[l]) || 0), 0);
  const countsBad = countSum > 0 && (f.n === '' || countSum > Number(f.n));
  const [details, setDetails] = useState((r?.entries?.length ?? 0) > 0);
  const [entries, setEntries] = useState<EpaEntry[]>(r?.entries?.length ? r.entries : [blankEntry()]);
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const canSave = f.reviewed && !!f.decision && (f.decision !== 'met' || f.confirmed) && w.me !== w.learner.id && !countsBad;

  async function save() {
    setBusy(true);
    setErr(undefined);
    try {
      await rpc('verify_epa', {
        p_learner: w.learner.id, p_cohort: w.cohort.id, p_reviewed: f.reviewed, p_criteria_status: f.decision,
        p_criteria_confirmed: f.decision === 'met' && f.confirmed, p_strengths: f.strengths, p_areas: f.areas, p_concerns: f.concerns,
        p_details: {
          assessments_reviewed: f.n === '' ? null : Math.max(0, Math.floor(Number(f.n))),
          entrustment_counts: Object.fromEntries(LEVELS.filter((l) => Number(f.counts[l]) > 0).map((l) => [l, Math.floor(Number(f.counts[l]))])),
          key_findings: f.findings,
        },
        p_entries: details
          ? entries.filter((e) => e.epa.trim() || e.title?.trim() || e.entrustment?.trim() || e.comment?.trim())
            .map((e) => ({ ...e, n_assessments: e.n_assessments == null || (e.n_assessments as any) === '' ? null : Number(e.n_assessments) }))
          : null,
      });
      reload();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  }
  const setEntry = (i: number, k: keyof EpaEntry, v: any) => setEntries(entries.map((e, j) => (j === i ? { ...e, [k]: v } : e)));
  const label = r?.criteria_status ? CRITERIA_LABEL[r.criteria_status] : null;

  return (
    <section>
      <SectionHead id="epa" letter="C" title="EPA review (Elentra)">
        {verified ? <Badge tone={r!.criteria_status === 'met' ? 'ok' : 'warn'}>Criteria {label}</Badge> : <Badge tone="warn">{legacy ? 'Re-verify' : 'Pending'}</Badge>}
      </SectionHead>
      <p className="small muted" style={{ marginTop: -4 }}>
        Review the resident's EPA assessments in Elentra, then record your verification here. You don't need to re-type EPA titles, ratings or comments.
      </p>
      {legacy && <div className="notice warn small" style={{ marginBottom: 10 }}>This review was recorded with the earlier form and has no criteria decision. Please re-verify.</div>}
      {verified && !editing && (
        <div className="panel stack" data-testid="epa-summary">
          <div><strong>✓ Reviewed in Elentra</strong> by {r!.completed_by_name ?? 'faculty'} · {fmtDate(r!.completed_at)} — C6 POCUS EPA criteria <strong>{label}</strong></div>
          {r!.criteria_snapshot && <div className="small muted">Criteria at the time: {r!.criteria_snapshot}</div>}
          {r!.strengths && <div className="small"><strong>Strengths:</strong> {r!.strengths}</div>}
          {r!.areas_for_improvement && <div className="small"><strong>Areas for improvement:</strong> {r!.areas_for_improvement}</div>}
          {r!.assessments_reviewed != null && <div className="small"><strong>C6 assessments reviewed:</strong> {r!.assessments_reviewed}{entrustmentText(r!.entrustment_counts) ? ` — ${entrustmentText(r!.entrustment_counts)}` : ''}</div>}
          {r!.key_findings && <div className="small"><strong>Findings:</strong> {r!.key_findings}</div>}
          {r!.concerns && <div className="notice warn small"><strong>Concerns:</strong> {r!.concerns} <span className="muted">(carried into the ITAR draft)</span></div>}
          {(r!.entries?.length ?? 0) > 0 && <div className="small muted">{r!.entries.length} optional EPA detail row(s) recorded.</div>}
          <div><button className="btn secondary small" onClick={() => setEditing(true)} data-testid="epa-update">Update verification</button></div>
        </div>
      )}
      {editing && (
        <div className="panel stack" data-testid="epa-form">
          <div className="small" style={{ background: 'var(--paper2)', border: '1px solid var(--rule)', borderRadius: 6, padding: '8px 10px' }}>
            <strong>C6 POCUS EPA completion criteria</strong>{' '}
            {crit.data && (crit.data.approved ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">draft — pending director approval</Badge>)}
            <div style={{ marginTop: 4 }}>{crit.data?.text || <span className="muted">Not configured yet (Admin → ITAR setup). "Met" cannot be recorded until the criteria are set.</span>}</div>
          </div>
          <label className="check"><input type="checkbox" checked={f.reviewed} onChange={(e) => setF({ ...f, reviewed: e.target.checked })} data-testid="epa-reviewed" />{' '}
            I reviewed this resident's EPA assessments in Elentra.</label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small"><strong>Are the C6 POCUS EPA criteria met?</strong></legend>
            <div className="row">
              {(['met', 'partially_met', 'outstanding'] as const).map((k) => (
                <label key={k} className="check"><input type="radio" name={`epa-decision-${w.learner.id}`} checked={f.decision === k} disabled={k === 'met' && !crit.data?.text}
                  onChange={() => setF({ ...f, decision: k, confirmed: false })} data-testid={`epa-decision-${k}`} /> {k === 'met' ? 'Met' : k === 'partially_met' ? 'Partially met' : 'Outstanding'}</label>
              ))}
            </div>
          </fieldset>
          {f.decision === 'met' && (
            <label className="check"><input type="checkbox" checked={f.confirmed} onChange={(e) => setF({ ...f, confirmed: e.target.checked })} data-testid="epa-criteria-confirmed" />{' '}
              I confirm the completion criteria above are met.</label>
          )}
          <details className="disclosure" open={!!(f.n || f.findings)} data-testid="epa-c6-details">
            <summary>Optional C6 details from Elentra — number reviewed, entrustment, findings</summary>
            <p className="small muted" style={{ margin: '4px 0 8px' }}>Only if you have them in front of you. They appear once in the ITER evidence section and never decide whether the C6 criteria are met.</p>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field" style={{ maxWidth: 190 }}>C6 POCUS assessments reviewed
                <input type="number" min={0} max={500} value={f.n} onChange={(e) => setF({ ...f, n: e.target.value })} data-testid="epa-n-reviewed" /></label>
              {LEVELS.map((l) => (
                <label key={l} className="field" style={{ maxWidth: 92 }}>Level {l}{l === '5' ? <span className="hint">“did not need to be there”</span> : l === '1' ? <span className="hint">“I had to do”</span> : null}
                  <input type="number" min={0} value={f.counts[l]} onChange={(e) => setF({ ...f, counts: { ...f.counts, [l]: e.target.value } })} aria-label={`Assessments at entrustment level ${l}`} data-testid={`epa-level-${l}`} /></label>
              ))}
            </div>
            {countsBad && <p className="small" style={{ color: 'var(--bad-ink, #a33)' }}>The entrustment counts add up to more than the number of assessments reviewed.</p>}
            <label className="field">Important findings <span className="hint">brief; no patient details</span>
              <textarea rows={2} value={f.findings} maxLength={2000} onChange={(e) => setF({ ...f, findings: e.target.value })} data-testid="epa-findings" /></label>
          </details>
          <details className="disclosure" open={!!(f.strengths || f.areas || f.concerns)}>
            <summary>Optional notes — strengths, areas for improvement, concerns</summary>
            <div className="formgrid">
              <label className="field">Strengths<textarea rows={2} value={f.strengths} onChange={(e) => setF({ ...f, strengths: e.target.value })} data-testid="epa-strengths" /></label>
              <label className="field">Areas for improvement<textarea rows={2} value={f.areas} onChange={(e) => setF({ ...f, areas: e.target.value })} /></label>
              <label className="field">Concerns <span className="hint">brief; carried into the ITAR draft</span>
                <textarea rows={2} value={f.concerns} onChange={(e) => setF({ ...f, concerns: e.target.value })} data-testid="epa-concerns" /></label>
            </div>
          </details>
          <label className="check small"><input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} /> Also record individual EPA details (optional)</label>
          {details && (
            <div className="tablewrap">
              <table className="data">
                <thead><tr><th>EPA</th><th>Title</th><th className="num"># assessments</th><th>Entrustment</th><th>Comment</th><th /></tr></thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={i}>
                      <td><input type="text" value={e.epa} onChange={(x) => setEntry(i, 'epa', x.target.value)} aria-label="EPA identifier" style={{ minWidth: 90 }} /></td>
                      <td><input type="text" value={e.title ?? ''} onChange={(x) => setEntry(i, 'title', x.target.value)} aria-label="EPA title" /></td>
                      <td><input type="number" min={0} value={e.n_assessments ?? ''} onChange={(x) => setEntry(i, 'n_assessments', x.target.value === '' ? null : Number(x.target.value))} aria-label="Number of assessments" style={{ width: 70 }} /></td>
                      <td><input type="text" value={e.entrustment ?? ''} onChange={(x) => setEntry(i, 'entrustment', x.target.value)} aria-label="Entrustment" /></td>
                      <td><input type="text" value={e.comment ?? ''} onChange={(x) => setEntry(i, 'comment', x.target.value)} aria-label="Comment" /></td>
                      <td>{entries.length > 1 && <button className="btn ghost small" onClick={() => setEntries(entries.filter((_, j) => j !== i))} aria-label="Remove EPA row">✕</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn ghost small" onClick={() => setEntries([...entries, blankEntry()])}>+ Add EPA</button>
            </div>
          )}
          <div className="row">
            <button className="btn small" disabled={busy || !canSave} onClick={save} data-testid="epa-save">Save verification</button>
            {verified && <button className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>}
            <span className="small muted">Your name and today's date are recorded automatically.</span>
          </div>
          <ErrorNote error={err} />
        </div>
      )}
    </section>
  );
}

function ObservationsSection({ w, reload, locked }: { w: Ws; reload: () => void; locked: boolean }) {
  const [f, setF] = useState({ category: 'scanning', observed_on: today(), context: '', body: '' });
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const block = w.observations.filter((o) => o.cohort_id === w.cohort.id);
  const other = w.observations.filter((o) => o.cohort_id !== w.cohort.id);

  async function add() {
    setBusy(true);
    setErr(undefined);
    const { error } = await supabase.from('faculty_notes').insert({
      course_id: w.cohort.course_id, learner_id: w.learner.id, cohort_id: w.cohort.id, author_id: w.me,
      category: f.category, observed_on: f.observed_on || null, context: f.context.trim(), body: f.body.trim(),
    });
    setBusy(false);
    if (error) setErr(error);
    else {
      setF({ ...f, context: '', body: '' });
      reload();
    }
  }
  async function remove(id: string) {
    const { error } = await supabase.from('faculty_notes').delete().eq('id', id);
    if (error) setErr(error);
    reload();
  }

  return (
    <section>
      <SectionHead id="observations" letter="D" title="Direct faculty observations" />
      <p className="small muted" style={{ marginTop: -4 }}>What you or colleagues directly observed during the block. These are separate from — and never derived from — the written exam.</p>
      <div className="split">
        <div className="stack">
          {!block.length && <Empty>No observations recorded for this block yet.</Empty>}
          {CATEGORIES.filter((c) => block.some((o) => o.category === c.key)).map((c) => (
            <div key={c.key} className="panel">
              <strong>{c.label}</strong>
              {block.filter((o) => o.category === c.key).map((o) => (
                <div key={o.id} className="small" style={{ borderTop: '1px solid var(--rule-soft)', paddingTop: 8, marginTop: 8 }}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{o.body}</div>
                  <div className="muted">
                    {o.author ?? 'Faculty'} · {o.observed_on ?? fmtDate(o.created_at, false)}{o.context ? ` · ${o.context}` : ''}
                    {o.author_id === w.me && !locked && <button className="btn ghost small" onClick={() => remove(o.id)}>Delete</button>}
                  </div>
                </div>
              ))}
            </div>
          ))}
          {other.length > 0 && (
            <details className="disclosure">
              <summary>Other faculty notes on file, not tied to this block ({other.length}) — not used in the draft</summary>
              {other.map((o) => <p key={o.id} className="small">“{o.body}” — {o.author ?? 'Faculty'}, {fmtDate(o.created_at, false)}</p>)}
            </details>
          )}
        </div>
        <aside className="panel stack">
          <strong>Add an observation</strong>
          <label className="field">Category
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} data-testid="obs-category">
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
          <label className="field">Observed on<input type="date" value={f.observed_on} onChange={(e) => setF({ ...f, observed_on: e.target.value })} /></label>
          <label className="field">Context <span className="hint">optional, e.g. “OR 12, pre-induction gastric scan”</span>
            <input type="text" value={f.context} maxLength={500} onChange={(e) => setF({ ...f, context: e.target.value })} />
          </label>
          <label className="field">What you observed<textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} data-testid="obs-body" /></label>
          <div><button className="btn small" disabled={busy || !f.body.trim()} onClick={add} data-testid="obs-add">Add observation</button></div>
          <ErrorNote error={err} />
        </aside>
      </div>
    </section>
  );
}

type TemplateRow = { name: string; status: 'draft' | 'confirmed'; confirmed_at: string | null; confirmed_by_name: string | null; definition: unknown };
const KIND_LABEL: Record<NonNullable<ItarSection['kind']>, { label: string; tone?: 'ok' | 'warn' | 'info' }> = {
  header: { label: 'Check' },
  evidence: { label: 'Verified evidence — factual', tone: 'info' },
  observations: { label: 'Faculty-entered' },
  role: { label: 'Notes from your observations' }, // earlier approved versions only
  outcome: { label: 'Your selection', tone: 'warn' },
  narrative: { label: 'Your judgement', tone: 'warn' },
  basis: { label: 'Your confirmation', tone: 'warn' },
  discussed: { label: 'Your selection', tone: 'warn' },
  record: { label: 'For your files' },
};

function DraftSection({ w, reload, selectedAttempt, rotation, template }: { w: Ws; reload: () => void; selectedAttempt: string | null; rotation: Rotation | null; template: TemplateRow | null }) {
  const ev = w.evaluation;
  const locked = ev?.status === 'approved';
  const T = useMemo(() => (template ? parseTemplate(template.definition) : null), [template]);
  const [f, setF] = useState(() => {
    const iter = (ev?.iter_fields ?? {}) as IterFields;
    return {
      strengths: ev?.strengths ?? '', areas: ev?.areas_for_improvement ?? '', other: ev?.observations ?? '',
      // nothing counts as a confirmed basis of assessment unless the faculty member ticked it (older drafts pre-ticked suggestions)
      iter: locked || iter.basis_confirmed ? iter : { ...iter, basis: [] },
      sections: (ev?.itar_sections ?? []) as ItarSection[], snapshot: ev?.evidence_snapshot ?? {}, generated_at: ev?.generated_at ?? null,
    };
  });
  const [view, setView] = useState<'quick' | 'evidence'>('quick');
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'approve' | 'reopen' | 'regenerate' | null>(null);

  const input: ItarInput = useMemo(() => ({
    learnerName: w.learner.full_name || w.learner.email, trainingLevel: w.learner.training_level, rotation: w.cohort.course, blockName: w.cohort.name,
    blockStart: w.cohort.start_date, blockEnd: w.cohort.end_date, examAssigned: w.exam_assigned, attempts: w.attempts, selectedAttemptId: selectedAttempt,
    requirements: w.requirements, epa: w.epa_review, observations: w.observations.filter((o) => o.cohort_id === w.cohort.id),
    strengths: f.strengths, areasForImprovement: f.areas, otherComments: f.other, today: today(),
    rotationReqs: rotation ? withSelectedAttempt(rotation, chooseAttempt(w.attempts, selectedAttempt).attempt, chooseAttempt(w.attempts, selectedAttempt).rule) : null,
  }), [w, selectedAttempt, f.strengths, f.areas, f.other, rotation]);
  // ITER layout for new drafts when a template exists; drafts and approved versions keep the layout they were written in
  const iterMode = f.sections.length ? isIterDraft(f.sections) : !!T;
  const changes = locked ? rotation?.itar?.changes_since_approval ?? [] : [];
  const fp = fingerprint(input);
  const stale = f.sections.length > 0 && f.snapshot?.fingerprint && f.snapshot.fingerprint !== fp;
  const todo = outstanding(input);
  const placeholders = f.sections.some((s) => NEEDS_FACULTY.test(s.text));
  const name = input.learnerName;
  const quick = iterMode ? quickSections(f.sections) : [];
  const record = iterMode ? evidenceSections(f.sections) : f.sections;
  const shown = iterMode ? (view === 'quick' ? quick : record) : f.sections;
  const compose = (s: ItarSection[]) => (isIterDraft(s) ? composeIter(s) : composeSummary(s));

  function generate() {
    const chosen = chooseAttempt(w.attempts, selectedAttempt);
    let next = { ...f };
    if (T) {
      // concise drafts from verified facts; text the faculty member wrote or edited is never replaced
      const cur = { overall: f.iter.overall ?? '', strengths: f.strengths, areas: f.areas, recommendations: f.iter.recommendations ?? '' };
      const { values, auto } = refreshDrafts(cur, f.iter.auto, quickDrafts(input));
      const iter: IterFields = { ...f.iter, overall: values.overall, recommendations: values.recommendations, auto };
      next = { ...f, strengths: values.strengths, areas: values.areas, iter };
      next.sections = draftIter({ ...input, strengths: values.strengths, areasForImprovement: values.areas }, T, iter);
    } else {
      next.sections = draftItar(input);
    }
    setF({
      ...next, generated_at: new Date().toISOString(),
      snapshot: {
        fingerprint: fp, attempt_id: chosen.attempt?.id ?? null, attempt_rule: chosen.rule, template: template ? { name: template.name, status: template.status } : null,
        evidence: w.requirements.map((r) => ({ requirement: r.title, state: requirementState(r), submission: latestSubmission(r)?.id ?? null, sha256: latestSubmission(r)?.sha256 ?? null })),
        epa: w.epa_review ? { status: w.epa_review.status, completed_at: w.epa_review.completed_at } : null,
        observations: input.observations.map((o) => o.id),
        requirements: rotation ? rotation.requirements.map((r) => ({ key: r.key, status: r.status, verified_by: r.verified_by_name, verified_at: r.verified_at })) : null,
        scans: rotation ? rotation.scans.categories.map((c) => ({ key: c.key, verified: c.verified, target: c.target, views_confirmed: c.views_confirmed })) : null,
      },
    });
    setView('quick');
    setMsg(T ? 'One45 fields drafted from the portal evidence. Review and edit each one, confirm the basis of assessment, then save.' : 'Draft assembled from the evidence above. Edit any section before saving.');
    setConfirm(null);
  }
  /** Faculty fields re-render their own ITER sections immediately; evidence text is untouched. */
  function setFaculty(patch: Partial<{ strengths: string; areas: string; iter: IterFields }>) {
    const next = { ...f, ...patch };
    const sections = T && isIterDraft(f.sections) ? applyFaculty(f.sections, T, next.iter, { strengths: next.strengths, areas: next.areas }) : f.sections;
    setF({ ...next, sections });
  }

  async function save(approve = false) {
    setBusy(true);
    setErr(undefined);
    setMsg(null);
    try {
      const chosen = chooseAttempt(w.attempts, selectedAttempt);
      const body = {
        course_id: w.cohort.course_id, learner_id: w.learner.id, cohort_id: w.cohort.id, rotation_start: w.cohort.start_date, rotation_end: w.cohort.end_date,
        attempt_id: chosen.attempt?.id ?? null, attempt_rule: chosen.rule, exam_snapshot: factsFrom(chosen.attempt) ?? {},
        evidence_snapshot: f.snapshot ?? {}, generated_at: f.generated_at, itar_sections: f.sections,
        // the stored text: the One45 fields first, then the full evidence record
        summary: iterMode ? `${composeIter(quick)}\n\n${composeIter(record)}` : composeSummary(f.sections),
        strengths: f.strengths, areas_for_improvement: f.areas, observations: f.other, iter_fields: f.iter,
      };
      let id = ev?.id;
      if (!id) {
        const { data, error } = await supabase.from('evaluations').insert(body).select('id').single();
        if (error) throw error;
        id = data.id;
      } else {
        const { error } = await supabase.from('evaluations').update(body).eq('id', id);
        if (error) throw error;
      }
      if (approve) {
        const { error } = await supabase.from('evaluations').update({ status: 'approved' }).eq('id', id!);
        if (error) throw error;
      }
      reload();
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
    setConfirm(null);
  }
  async function reopen() {
    const { error } = await supabase.from('evaluations').update({ status: 'draft' }).eq('id', ev!.id);
    if (error) setErr(error);
    else reload();
    setConfirm(null);
  }
  async function logExport(format: string) {
    if (ev?.id) await rpc('log_itar_export', { p_evaluation: ev.id, p_format: format }).catch(() => {});
  }
  async function copy(text: string, format: 'copy_all' | 'copy_section', label: string) {
    setErr(undefined);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text); // locked-down browsers often block the async clipboard API
    }
    if (ok) {
      setMsg(`${label} copied — paste it into the ITER in One45.`);
      logExport(iterMode ? `iter_${format}` : format);
    } else {
      setErr(new Error('The browser blocked clipboard access. Use “Download .txt”, or select the text and copy it manually.'));
    }
  }
  const status = locked ? `draft approved by ${ev?.approved_by_name ?? 'faculty'} on ${fmtDate(ev?.approved_at)} — ready for One45 (not submitted)` : 'DRAFT — not approved';
  const header = (what: string) => `${what} — ${name}${w.learner.training_level ? ` (${w.learner.training_level})` : ''}\n${w.cohort.course}, ${w.cohort.name} (${dates(w.cohort)})\nStatus: ${status}\n${iterMode ? 'Copy each field into the One45 ITER (destination after →). CanMEDS ratings and the overall outcome are selected by faculty in One45, where the ITER is reviewed and submitted; the portal submits nothing.\n' : ''}\n`;
  const setSection = (i: number, text: string) => setF({ ...f, sections: f.sections.map((s, j) => (j === i ? { ...s, text } : s)) });
  const hints = T ? basisHints(input, T) : {};
  const fileBase = `${iterMode ? 'ITER' : 'ITAR'}_${name.replace(/\W+/g, '_')}_${w.cohort.name.replace(/\W+/g, '_')}`;

  /** Legacy ITAR layout and evidence-record text. */
  function textBody(s: ItarSection) {
    const i = f.sections.indexOf(s);
    const rows = Math.min(14, Math.max(3, s.text.split('\n').length + Math.ceil(s.text.length / 110)));
    if (iterMode) return <div className="evidence-text" data-testid={`section-${s.key}`}>{s.text}</div>;
    return <textarea rows={rows} value={s.text} disabled={locked} onChange={(e) => setSection(i, e.target.value)} aria-label={s.title} data-testid={`section-${s.key}`} />;
  }
  /** One45 field editors (Quick Copy). */
  function fieldBody(s: ItarSection) {
    if (!T) return textBody(s);
    // once approved, show the faculty selection as plain text (disabled controls are hard to read)
    if (locked && (s.kind === 'outcome' || s.kind === 'basis' || s.kind === 'discussed')) {
      return <div style={{ fontWeight: 600 }} data-testid={`iter-${s.kind}`}>{s.text}</div>;
    }
    if (s.kind === 'outcome') {
      return (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }} data-testid="iter-outcome">
          <legend className="sr-only">{s.title}</legend>
          <div className="stack" style={{ gap: 4 }}>
            {T.outcome.options.map((o) => (
              <label key={o} className="check" style={{ display: 'flex' }}><input type="radio" name="iter-outcome" checked={f.iter.outcome === o}
                onChange={() => setFaculty({ iter: { ...f.iter, outcome: o } })} /> {o}</label>
            ))}
            <label className="check muted" style={{ display: 'flex' }}><input type="radio" name="iter-outcome" checked={!f.iter.outcome}
              onChange={() => setFaculty({ iter: { ...f.iter, outcome: null } })} /> Not selected here (select in One45)</label>
          </div>
        </fieldset>
      );
    }
    if (s.kind === 'basis') {
      const sel = f.iter.basis ?? [];
      return (
        <div className="stack" style={{ gap: 6 }} data-testid="iter-basis">
          <span className="small muted">Tick what informed your assessment. Nothing is ticked for you.</span>
          {T.basis.options.map((o) => (
            <label key={o} className="check" style={{ display: 'flex', alignItems: 'flex-start' }}>
              <input type="checkbox" checked={sel.includes(o)} style={{ marginTop: 3 }}
                onChange={(e) => setFaculty({ iter: { ...f.iter, basis_confirmed: true, basis: e.target.checked ? T.basis.options.filter((x) => x === o || sel.includes(x)) : sel.filter((x) => x !== o) } })} />
              <span>{o}{hints[o] && <span className="small muted"> — {hints[o]}</span>}</span>
            </label>
          ))}
        </div>
      );
    }
    if (s.kind === 'discussed') {
      return (
        <div className="row" data-testid="iter-discussed">
          {([['yes', 'Yes'], ['no', 'No'], [null, 'Not recorded here']] as const).map(([v, l]) => (
            <label key={l} className="check"><input type="radio" name="iter-discussed" checked={(f.iter.discussed ?? null) === v}
              onChange={() => setFaculty({ iter: { ...f.iter, discussed: v } })} /> {l}</label>
          ))}
        </div>
      );
    }
    const k = s.key.replace('iter_', '') as NarrativeKey;
    const value = k === 'strengths' ? f.strengths : k === 'areas' ? f.areas : f.iter[k] ?? '';
    const set = (v: string) => (k === 'strengths' ? setFaculty({ strengths: v }) : k === 'areas' ? setFaculty({ areas: v }) : setFaculty({ iter: { ...f.iter, [k]: v } }));
    const drafted = !!value && value === f.iter.auto?.[k];
    return (
      <>
        {drafted && !locked && <div className="small" style={{ color: 'var(--petrol)', marginBottom: 4 }} data-testid={`drafted-${k}`}>Drafted from portal records — review and edit before approving.</div>}
        <textarea rows={Math.min(8, Math.max(3, Math.ceil(value.length / 95) + 1))} value={value} disabled={locked} onChange={(e) => set(e.target.value)} aria-label={s.title}
          placeholder={T.narrative[k].required ? `Required — the portal has no faculty feedback to draft this from. Write your ${T.narrative[k].heading.toLowerCase()}.` : 'Optional — or write it directly in One45'}
          data-testid={`iter-${k}`} />
      </>
    );
  }

  return (
    <section>
      <div className="no-print">
        <SectionHead id="itar" letter="E" title={iterMode ? 'ITER for One45' : 'ITAR draft'}>
          {locked ? <Badge tone="ok">Draft approved — ready for One45 · {fmtDate(ev?.approved_at)}{ev?.approved_by_name ? ` · ${ev.approved_by_name}` : ''}</Badge> : ev ? <Badge tone="warn">Draft</Badge> : <Badge>Not started</Badge>}
        </SectionHead>
        {template && iterMode && (
          <p className="small muted" style={{ marginTop: -4 }} data-testid="iter-template">
            Layout: <strong>{template.name}</strong>{' '}
            {template.status === 'confirmed'
              ? <Badge tone="ok">confirmed{template.confirmed_by_name ? ` by ${template.confirmed_by_name}` : ''}</Badge>
              : <><Badge tone="warn">draft</Badge> The rotation director still needs to confirm it matches the current POCUS block ITER.</>}
            {' '}The overall outcome and CanMEDS ratings are never filled in by the portal. Nothing is sent to One45.
          </p>
        )}
        {locked && changes.length === 0 && <div className="notice ok small" style={{ marginBottom: 12 }} data-testid="ready-for-one45"><strong>Draft approved — ready for One45.</strong> This does not submit the ITER: copy each field into the resident's ITER in One45, complete the ratings there, then review and submit it in One45. Re-open here to make changes (recorded in the audit log).</div>}
        {locked && changes.length > 0 && (
          <div className="notice warn small" style={{ marginBottom: 12 }} data-testid="itar-changed">
            <strong>New evidence since this draft was approved ({fmtDate(ev?.approved_at)}).</strong> The approved draft is unchanged and preserved. If you already submitted the ITER in One45, any correction is made in One45.
            <ul style={{ margin: '6px 0' }}>{changes.map((c, i) => <li key={i}>{c.area}: {c.what} — {fmtDate(c.at)}</li>)}</ul>
            If this affects the evaluation, start a revision: re-open, regenerate, review and approve again (a new version is kept alongside the original).
            <div style={{ marginTop: 8 }}><button className="btn small" onClick={() => setConfirm('reopen')} data-testid="start-revision">Start a revision…</button></div>
          </div>
        )}
        <VersionHistory evaluationId={ev?.id ?? null} count={rotation?.itar?.versions ?? 0} />
        {!locked && todo.length > 0 && !iterMode && (
          <div className="notice warn small" style={{ marginBottom: 12 }}>
            <strong>Outstanding:</strong> {todo.join(' · ')}. You can still prepare the draft; outstanding items are listed in it.
          </div>
        )}
        {!iterMode && (
          <div className="formgrid">
            <label className="field">Strengths <span className="hint">your synthesis</span>
              <textarea rows={3} value={f.strengths} disabled={locked} onChange={(e) => setF({ ...f, strengths: e.target.value })} data-testid="eval-strengths" />
            </label>
            <label className="field">Areas for improvement / learning plan
              <textarea rows={3} value={f.areas} disabled={locked} onChange={(e) => setF({ ...f, areas: e.target.value })} data-testid="eval-areas" />
            </label>
            <label className="field">Additional comments <span className="hint">optional</span>
              <textarea rows={3} value={f.other} disabled={locked} onChange={(e) => setF({ ...f, other: e.target.value })} />
            </label>
          </div>
        )}
        {!locked && f.sections.length > 0 && !iterMode && T && (
          <div className="notice small" style={{ margin: '10px 0' }}>This draft uses the earlier ITAR layout. Regenerate it to switch to the ITER for One45 (your strengths and areas text is kept).</div>
        )}
        {!locked && (
          <div className="row" style={{ margin: '14px 0' }}>
            <button className="btn" onClick={() => (f.sections.length ? setConfirm('regenerate') : generate())} data-testid="generate-draft">
              {f.sections.length ? 'Refresh from evidence' : T ? 'Prepare ITER for One45' : 'Generate ITAR draft from evidence'}
            </button>
            {stale && <span className="small" style={{ color: 'var(--warn-ink)' }}>Evidence has changed since this draft was prepared.</span>}
          </div>
        )}
        {iterMode && f.sections.length > 0 && (
          <div className="tabs" role="tablist" aria-label="ITER views" style={{ marginBottom: 12 }}>
            <button role="tab" aria-selected={view === 'quick'} className={view === 'quick' ? 'active' : ''} onClick={() => setView('quick')} data-testid="view-quick">ITER Quick Copy</button>
            <button role="tab" aria-selected={view === 'evidence'} className={view === 'evidence' ? 'active' : ''} onClick={() => setView('evidence')} data-testid="view-evidence">Full Evidence Record</button>
          </div>
        )}
        {iterMode && view === 'quick' && f.sections.length > 0 && (
          <p className="small muted" style={{ margin: '0 0 10px' }}>
            The One45 fields, in form order. Factual parts are drafted from verified portal records and your notes; nothing is rated or judged for you.
            Edit each field, then <strong>Copy</strong> it into the same field in One45. CanMEDS ratings are ticked directly in One45.
          </p>
        )}
        {shown.length > 0 && (
          <div className="stack" data-testid="itar-sections">
            {shown.map((s) => (
              <div key={s.key} className="panel" data-testid={`iter-section-${s.key}`}>
                <div className="row between" style={{ marginBottom: 4, alignItems: 'flex-start' }}>
                  <div>
                    <strong>{s.title}</strong>{' '}
                    {s.kind && <Badge tone={KIND_LABEL[s.kind].tone}>{KIND_LABEL[s.kind].label}</Badge>}
                  </div>
                  <button className="btn ghost small" onClick={() => copy(s.text, 'copy_section', s.title)} disabled={NEEDS_FACULTY.test(s.text)} data-testid={`copy-${s.key}`}>Copy</button>
                </div>
                {s.dest && <div className="small muted" style={{ marginBottom: 6 }}>→ {s.dest}</div>}
                {iterMode && QUICK_KINDS.includes(s.kind) ? fieldBody(s) : textBody(s)}
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          {!locked && <button className="btn secondary" disabled={busy || !f.sections.length} onClick={() => save(false)} data-testid="save-eval">Save draft</button>}
          {!locked && <button className="btn" disabled={busy || !f.sections.length || placeholders} onClick={() => setConfirm('approve')} data-testid="approve-eval"
            title={placeholders ? 'Complete the fields marked “Faculty to complete / confirm” first' : undefined}>Approve draft…</button>}
          {locked && <button className="btn secondary" onClick={() => setConfirm('reopen')}>Re-open for editing</button>}
          {iterMode && quick.length > 0 && <button className="btn secondary" onClick={() => copy(composeIter(quick), 'copy_all', 'All One45 fields')} data-testid="copy-all">Copy all One45 fields</button>}
          {!iterMode && f.sections.length > 0 && <button className="btn secondary" onClick={() => copy(composeSummary(f.sections), 'copy_all', 'Whole draft')} data-testid="copy-all">Copy all</button>}
          {shown.length > 0 && <button className="btn secondary" onClick={() => {
            const what = !iterMode ? 'ITAR preparation' : view === 'quick' ? 'ITER Quick Copy' : 'Full Evidence Record';
            download(`${fileBase}${iterMode && view === 'evidence' ? '_evidence' : ''}.txt`, header(what) + compose(shown), 'text/plain;charset=utf-8');
            logExport(iterMode ? 'iter_text' : 'text');
          }} data-testid="export-text">Download .txt</button>}
          {shown.length > 0 && <button className="btn secondary" onClick={() => { logExport('print'); window.print(); }} data-testid="print">Print / PDF</button>}
          {f.sections.length > 0 && <button className="btn secondary" onClick={() => { download(`${fileBase}.csv`, toCSV([{ resident: name, block: w.cohort.name, status: ev?.status ?? 'draft', approved_at: ev?.approved_at ?? '', ...Object.fromEntries(f.sections.map((s) => [s.title, s.text])) }])); logExport('csv'); }}>CSV</button>}
        </div>
        {placeholders && !locked && <p className="small muted">Complete the fields marked “Faculty to complete / confirm” before approving.</p>}
        {msg && <div className="notice ok small" role="status" style={{ marginTop: 10 }}>{msg}</div>}
        <ErrorNote error={err} />
      </div>

      {/* print view: only what is on screen (Quick Copy or the evidence record) */}
      <div className="print-only print-doc">
        <div className="print-head">
          <strong>{!iterMode ? 'ITAR preparation' : view === 'quick' ? 'ITER for One45 — Quick Copy' : 'ITER — Full Evidence Record'}</strong> · {name}{w.learner.training_level ? ` (${w.learner.training_level})` : ''}
          <div>{w.cohort.course}, {w.cohort.name} ({dates(w.cohort)}) · {locked ? `Draft approved by ${ev?.approved_by_name ?? 'faculty'} on ${fmtDate(ev?.approved_at)} — ready for One45; not submitted by the portal` : 'DRAFT — not approved'}</div>
        </div>
        {shown.map((s) => (
          <div key={s.key} className={`print-sec ${s.kind === 'evidence' ? 'long' : ''}`}>
            <h3>{s.title}</h3>
            {s.dest && <div className="print-dest">→ {s.dest}</div>}
            <div className="print-text">{s.text}</div>
          </div>
        ))}
      </div>

      {confirm === 'regenerate' && (
        <Confirm title="Refresh from the evidence?" confirmLabel="Refresh" onCancel={() => setConfirm(null)} onConfirm={generate}
          body={<p>The evidence record is rebuilt from the current records{T ? ', and drafted One45 fields you have not edited are updated' : ''}. Text you wrote or edited, and your selections, are kept.</p>} />
      )}
      {confirm === 'approve' && (
        <Confirm title="Approve this draft for One45?" confirmLabel="Approve draft" onCancel={() => setConfirm(null)} onConfirm={() => save(true)}
          body={<div className="stack small">
            <p>By approving, you confirm that you reviewed the evidence and every field, including any text drafted from portal records, that it reflects your professional judgement, and that it contains no statement about clinical or technical performance that was not directly observed or documented.</p>
            <p>Approving here locks the draft as <strong>ready for One45</strong>; it does <strong>not</strong> submit the ITER. CanMEDS ratings and the overall rotation outcome are selected by you in One45, where you review and submit the ITER. The portal assigns no rating and submits nothing.</p>
          </div>} />
      )}
      {confirm === 'reopen' && (
        <Confirm title="Re-open for editing?" confirmLabel="Re-open" onCancel={() => setConfirm(null)} onConfirm={reopen}
          body={<p>The current approval is withdrawn so you can edit (recorded in the audit log). The approved text is kept as a numbered version; approving again adds a new version.</p>} />
      )}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Rotation requirements (completion tracker)
// ---------------------------------------------------------------------------
const SECTION_FOR: Partial<Record<RotationReq['kind'], string>> = { exam: '#exam', learning_cases: '#cases', epa: '#epa', scan_log: '#scans' };

function RequirementsSection({ w, rot, reload, setRot }: { w: Ws; rot: Rotation; reload: () => void; setRot: (r: Rotation) => void }) {
  const c = completion(rot.requirements);
  return (
    <section>
      <SectionHead id="requirements" letter="✓" title="Rotation requirements">
        <span className="small"><strong>{c.done}/{c.total}</strong> complete · <strong>{rot.scans.verified_total}/{rot.scans.target_total}</strong> verified scans</span>
      </SectionHead>
      <p className="small muted" style={{ marginTop: -4 }}>
        Exam, learning cases and EPA statuses update automatically from the sections below. Completion is a checklist, not a competence rating.
      </p>
      <div className="tablewrap">
        <table className="data" data-testid="requirements-table">
          <thead><tr><th>Requirement</th><th>Status</th><th>Details</th><th>Verified</th><th>Action</th></tr></thead>
          <tbody>
            {rot.requirements.map((r) => <ReqRow key={r.id} r={r} w={w} setRot={setRot} lastScan={r.kind === 'scan_log' ? rot.scans.history[0] : undefined} />)}
          </tbody>
        </table>
      </div>
      <ScanLog w={w} rot={rot} setRot={setRot} reload={reload} />
    </section>
  );
}

function ReqRow({ r, w, setRot, lastScan }: { r: RotationReq; w: Ws; setRot: (r: Rotation) => void; lastScan?: Rotation['scans']['history'][number] }) {
  const [msgFor, setMsgFor] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const canAct = w.me !== w.learner.id;

  async function set(status: ReqStatus | 'clear', stage: string | null = null, note: string | null = null) {
    setBusy(true);
    setErr(undefined);
    try {
      setRot(await rpc<Rotation>('set_requirement_status', { p_requirement: r.id, p_learner: w.learner.id, p_cohort: w.cohort.id, p_status: status, p_stage: stage, p_note: note }));
      setMsgFor(false);
      setMessage('');
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  }
  function other(v: string) {
    if (!v) return;
    if (v === 'clarify') setMsgFor(true);
    else if (v.startsWith('stage:')) set(r.status === 'not_started' ? 'in_progress' : (r.status as ReqStatus), v.slice(6));
    else set(v as ReqStatus | 'clear');
  }
  const attest = r.kind === 'attestation';
  return (
    <tr data-testid={`req-${r.key}`}>
      <td>
        <strong>{r.title}</strong>{!r.required && <span className="small muted"> · optional</span>}
        {r.description && <div className="small muted" style={{ maxWidth: 320 }}>{r.description}</div>}
      </td>
      <td><Badge tone={REQ_TONE[r.status]}>{REQ_LABEL[r.status]}</Badge>{r.override && <div className="small muted">set by faculty</div>}</td>
      <td className="small">
        {r.detail}
        {r.resident_note && <div>Resident: “{r.resident_note}”</div>}
        {r.faculty_message && <div className="muted">Message to resident: “{r.faculty_message}”</div>}
        {r.extra?.evidence && <div className="muted">Optional upload: {r.extra.evidence.filename} ({r.extra.evidence.status})</div>}
        {r.kind === 'exam' && r.extra?.pass_pct != null && <div className="muted">Rotation pass mark {Math.round(r.extra.pass_pct)}%</div>}
      </td>
      <td className="small">
        {r.verified_by_name ? <>{r.verified_by_name}<div className="muted">{fmtDate(r.verified_at, false)}</div></>
          : lastScan ? <><span className="muted">Last attested:</span> {lastScan.by}<div className="muted">{fmtDate(lastScan.created_at, false)}</div></> : '—'}
      </td>
      <td className="small">
        {SECTION_FOR[r.kind] && <a href={SECTION_FOR[r.kind]} className="btn ghost small">{r.kind === 'scan_log' ? 'Attest scans ↓' : 'Open ↓'}</a>}
        {canAct && attest && r.status !== 'verified' && (
          <button className="btn small" disabled={busy} onClick={() => set('verified')} data-testid={`req-verify-${r.key}`}>Confirm complete</button>
        )}
        {canAct && (
          <select aria-label={`More actions for ${r.title}`} value="" disabled={busy} onChange={(e) => other(e.target.value)} data-testid={`req-more-${r.key}`} style={{ marginLeft: 6, maxWidth: 170 }}>
            <option value="">More…</option>
            {attest && r.stages.map((s) => <option key={s.key} value={`stage:${s.key}`}>Stage: {s.label}</option>)}
            {attest && r.status !== 'clarification_requested' && <option value="clarify">Needs clarification…</option>}
            {attest && r.status === 'verified' && <option value="in_progress">Re-open (in progress)</option>}
            <option value="not_yet_due">Not yet due</option>
            <option value="not_applicable">Not applicable</option>
            {(attest ? r.status !== 'not_started' : r.override) && <option value={attest ? 'not_started' : 'clear'}>{attest ? 'Reset to not started' : 'Clear (use automatic status)'}</option>}
          </select>
        )}
        {msgFor && (
          <div className="stack" style={{ marginTop: 8 }}>
            <input type="text" maxLength={500} placeholder="Message to the resident (no patient details)" value={message} onChange={(e) => setMessage(e.target.value)} aria-label="Message to the resident" data-testid={`req-message-${r.key}`} />
            <div className="row">
              <button className="btn small" disabled={busy || !message.trim()} onClick={() => set('clarification_requested', null, message)}>Send</button>
              <button className="btn ghost small" onClick={() => setMsgFor(false)}>Cancel</button>
            </div>
          </div>
        )}
        <ErrorNote error={err} />
      </td>
    </tr>
  );
}

function ScanLog({ w, rot, setRot, reload }: { w: Ws; rot: Rotation; setRot: (r: Rotation) => void; reload: () => void }) {
  const cats = rot.scans.categories;
  const [totals, setTotals] = useState<Record<string, string>>({});
  const [views, setViews] = useState<Record<string, boolean>>({});
  const [reviewedOn, setReviewedOn] = useState(today());
  const [note, setNote] = useState('');
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const { entries, negative } = scanDeltas(cats, totals, views);
  const pending = cats.some((c) => (c.reported ?? 0) > c.verified);
  const canAct = w.me !== w.learner.id;
  if (!cats.length) return null;

  function acceptReported() {
    setTotals(Object.fromEntries(cats.map((c) => [c.id, String(Math.max(c.verified, c.reported ?? 0))])));
    setMsg(null);
  }
  async function record() {
    setBusy(true);
    setErr(undefined);
    setMsg(null);
    try {
      const r = await rpc<Rotation>('attest_scans', {
        p_learner: w.learner.id, p_cohort: w.cohort.id, p_entries: entries, p_reviewed_on: reviewedOn, p_note: note.trim(), p_correction: negative, p_attested: attested,
      });
      setRot(r);
      setTotals({});
      setViews({});
      setNote('');
      setAttested(false);
      setMsg(`Recorded ${entries.length} categor${entries.length === 1 ? 'y' : 'ies'}${negative ? ' (correction)' : ''}.`);
      reload();
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
  }

  return (
    <div className="panel stack" id="scans" style={{ marginTop: 16 }}>
      <div className="row between">
        <strong>Scan logbook — faculty-verified reviewed scans</strong>
        <span className="small"><strong>{rot.scans.verified_total}/{rot.scans.target_total}</strong>{rot.scans.reported_total != null && <span className="muted"> · resident reports {rot.scans.reported_total}</span>}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Review the studies in QPath (or another approved system), then record how many were reviewed and accepted. <strong>Counts only</strong> — never MRNs, names, dates of birth,
        scan dates or locations. Only these faculty-verified numbers count toward the targets.
      </p>
      <div className="tablewrap">
        <table className="data" data-testid="scan-table">
          <thead><tr><th>Category</th><th className="num">Target</th><th>Progress</th><th className="num">Resident reports</th><th>Verified total</th><th>Required views covered</th></tr></thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.id} data-testid={`scan-${c.key}`}>
                <td><strong>{c.label}</strong>{c.views_note && <div className="small muted" style={{ maxWidth: 240 }}>{c.views_note}</div>}</td>
                <td className="num">{c.target}</td>
                <td style={{ minWidth: 130 }}>
                  <div className="bar" aria-hidden><span style={{ width: `${scanPct(c)}%`, background: c.met ? 'var(--moss)' : undefined }} /></div>
                  <span className="small">{c.verified}/{c.target}{c.met ? ' ✓' : ''}</span>
                </td>
                <td className="num">{c.reported ?? '—'}{(c.reported ?? 0) > c.verified && <div className="small" style={{ color: 'var(--warn-ink)' }}>+{(c.reported ?? 0) - c.verified} to review</div>}</td>
                <td>
                  <input type="number" min={0} max={2000} style={{ width: 80 }} disabled={!canAct} aria-label={`Verified total for ${c.label}`} data-testid={`scan-total-${c.key}`}
                    value={totals[c.id] ?? String(c.verified)} onChange={(e) => setTotals({ ...totals, [c.id]: e.target.value })} />
                </td>
                <td>
                  {c.views_note ? (
                    <label className="check small"><input type="checkbox" disabled={!canAct} checked={views[c.id] ?? !!c.views_confirmed}
                      onChange={(e) => setViews({ ...views, [c.id]: e.target.checked })} data-testid={`scan-views-${c.key}`} /> confirmed</label>
                  ) : <span className="small muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canAct && (
        <>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            {pending && <button className="btn secondary small" onClick={acceptReported} data-testid="scan-accept-reported">Fill in resident-reported counts</button>}
            <label className="field" style={{ maxWidth: 170 }}>Reviewed on<input type="date" value={reviewedOn} max={today()} onChange={(e) => setReviewedOn(e.target.value)} /></label>
            <label className="field" style={{ flex: 1, minWidth: 200 }}>{negative ? 'Reason for the correction (required)' : 'Note (optional, no patient details)'}
              <input type="text" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} data-testid="scan-note"
                placeholder={negative ? 'e.g. two studies were entered twice' : 'e.g. reviewed in QPath with the resident'} />
            </label>
            <label className="check small" style={{ flexBasis: '100%' }}>
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} data-testid="scan-attest" />{' '}
              I reviewed these studies (images) in QPath or another approved system and accept them as meeting program requirements. This records completion, not competence.
            </label>
            <button className="btn" disabled={busy || !entries.length || !attested || (negative && !note.trim())} onClick={record} data-testid="scan-record">
              {negative ? 'Record correction' : `Record attestation${entries.length ? ` (${entries.length})` : ''}`}
            </button>
          </div>
          {msg && <div className="notice ok small" role="status">{msg}</div>}
          <ErrorNote error={err} />
        </>
      )}
      {rot.scans.history.length > 0 && (
        <details className="disclosure">
          <summary>Attestation history ({rot.scans.history.length})</summary>
          <ul className="small">
            {rot.scans.history.map((h) => (
              <li key={h.batch_id}>
                {fmtDate(h.created_at)} · {h.by ?? 'Faculty'} · reviewed {h.reviewed_on}{h.is_correction ? ' · correction' : ''}:{' '}
                {h.entries.map((e) => `${e.category} ${e.delta > 0 ? '+' : ''}${e.delta}${e.views_confirmed != null ? (e.views_confirmed ? ', views ✓' : ', views ✗') : ''}`).join('; ')}
                {h.note && <span className="muted"> — “{h.note}”</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approved ITAR versions (immutable)
// ---------------------------------------------------------------------------
function VersionHistory({ evaluationId, count }: { evaluationId: string | null; count: number }) {
  const [open, setOpen] = useState(false);
  const v = useLoad(async () => {
    if (!open || !evaluationId) return [];
    const { data, error } = await supabase.from('evaluation_versions').select('version, summary, approved_at, approved_by, profiles:approved_by(full_name)')
      .eq('evaluation_id', evaluationId).order('version', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, [open, evaluationId]);
  if (!evaluationId || count === 0) return null;
  return (
    <details className="disclosure" style={{ marginBottom: 12 }} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="itar-versions">
      <summary>Approved draft versions ({count}) — preserved exactly as approved</summary>
      {v.loading && <Spinner />}
      <ErrorNote error={v.error} />
      {(v.data ?? []).map((x) => (
        <details key={x.version} className="disclosure" style={{ marginLeft: 12 }}>
          <summary>Version {x.version} · approved {fmtDate(x.approved_at)}{x.profiles?.full_name ? ` by ${x.profiles.full_name}` : ''}</summary>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{x.summary}</div>
        </details>
      ))}
    </details>
  );
}
