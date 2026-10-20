import { useState } from 'react';
import { Page } from '../../components/Layout';
import { Badge, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../../components/ui';
import { cohorts as loadCohorts, pocusCourse } from '../../lib/content';
import { sideClient, supabase } from '../../lib/supabase';

type Tab = 'invitations' | 'users' | 'cohorts' | 'accommodations';

export function People() {
  const [tab, setTab] = useState<Tab>('invitations');
  return (
    <Page kicker="Administration" title="People & cohorts" subtitle="Invitation-only accounts, rotation cohorts and approved accommodations">
      <div className="tabs" role="tablist">
        {(['invitations', 'users', 'cohorts', 'accommodations'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'invitations' && <Invitations />}
      {tab === 'users' && <Users />}
      {tab === 'cohorts' && <Cohorts />}
      {tab === 'accommodations' && <Accommodations />}
    </Page>
  );
}

function Invitations() {
  const coh = useLoad(loadCohorts, []);
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('invitations').select('*, cohorts(name)').order('created_at', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, []);
  const [f, setF] = useState({ emails: '', full_name: '', role: 'learner', training_level: '', program: 'Anesthesiology', cohort_id: '' });
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  async function invite() {
    setErr(undefined);
    setMsg(null);
    const emails = f.emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (!emails.length || bad.length) {
      setErr(new Error(bad.length ? `Invalid email: ${bad.join(', ')}` : 'Enter at least one email'));
      return;
    }
    const rows = emails.map((email) => ({
      email, full_name: emails.length === 1 ? f.full_name : '', role: f.role, training_level: f.training_level || null,
      program: f.program || null, cohort_id: f.cohort_id || null, revoked_at: null,
    }));
    const { error } = await supabase.from('invitations').upsert(rows, { onConflict: 'email' });
    if (error) setErr(error);
    else {
      setMsg(`${emails.length} invitation(s) saved. Send each person their sign-in email below, or share the portal link.`);
      setF({ ...f, emails: '', full_name: '' });
      list.reload();
    }
  }

  async function sendSignIn(email: string) {
    setSending(email);
    setErr(undefined);
    const { error } = await sideClient().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    setSending(null);
    if (error) setErr(error);
    else setMsg(`Sign-in code emailed to ${email}.`);
  }

  const portal = `${window.location.origin}/app/login`;
  return (
    <div className="stack">
      <section className="card flat stack">
        <h3>Invite people</h3>
        <div className="formgrid">
          <label className="field">Email(s) <span className="hint">one or many, separated by commas or new lines</span>
            <textarea rows={2} value={f.emails} onChange={(e) => setF({ ...f, emails: e.target.value })} data-testid="invite-emails" />
          </label>
          <label className="field">Full name <span className="hint">single invitation only</span>
            <input type="text" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} data-testid="invite-name" />
          </label>
          <label className="field">Role
            <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} data-testid="invite-role">
              <option value="learner">Learner</option><option value="faculty">Faculty / evaluator</option><option value="admin">Administrator</option>
            </select>
          </label>
          <label className="field">Training level<input type="text" placeholder="e.g. PGY-3" value={f.training_level} onChange={(e) => setF({ ...f, training_level: e.target.value })} /></label>
          <label className="field">Program<input type="text" value={f.program} onChange={(e) => setF({ ...f, program: e.target.value })} /></label>
          <label className="field">Cohort <span className="hint">learners join as learners; faculty as evaluators</span>
            <select value={f.cohort_id} onChange={(e) => setF({ ...f, cohort_id: e.target.value })} data-testid="invite-cohort">
              <option value="">—</option>
              {(coh.data ?? []).filter((c) => !c.archived_at).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="row"><button className="btn" onClick={invite} data-testid="invite">Save invitation(s)</button></div>
        <p className="small muted">
          Invited people sign in at <span className="mono">{portal}</span> with their email; they receive a 6-digit code. Nobody else can create an account.
        </p>
        {msg && <div className="notice ok small" role="status">{msg}</div>}
        <ErrorNote error={err} />
      </section>
      {list.loading ? <Spinner /> : <ErrorNote error={list.error} />}
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Cohort</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(list.data ?? []).map((i) => (
              <tr key={i.email}>
                <td>{i.email}</td><td>{i.full_name || '—'}</td><td>{i.role}</td><td>{i.cohorts?.name ?? '—'}</td>
                <td>{i.revoked_at ? <Badge tone="bad">Revoked</Badge> : i.accepted_at ? <Badge tone="ok">Joined {fmtDate(i.accepted_at, false)}</Badge> : <Badge tone="info">Invited</Badge>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!i.revoked_at && !i.accepted_at && (
                    <button className="btn ghost small" disabled={sending === i.email} onClick={() => sendSignIn(i.email)}>{sending === i.email ? 'Sending…' : 'Email sign-in code'}</button>
                  )}
                  {!i.revoked_at && !i.accepted_at && (
                    <button className="btn ghost small" onClick={async () => { await supabase.from('invitations').update({ revoked_at: new Date().toISOString() }).eq('email', i.email); list.reload(); }}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Users() {
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('profiles').select('*, cohort_members(member_role, cohorts(name))').order('role').order('full_name');
    if (error) throw error;
    return data as any[];
  }, []);
  const [err, setErr] = useState<unknown>();
  async function patch(id: string, p: Record<string, unknown>) {
    setErr(undefined);
    const { error } = await supabase.from('profiles').update(p).eq('id', id);
    if (error) setErr(error);
    list.reload();
  }
  if (list.loading) return <Spinner />;
  return (
    <div className="stack">
      <ErrorNote error={err ?? list.error} />
      <p className="small muted">Deactivating removes access immediately while keeping the person's historical records. Accounts are never hard-deleted from here.</p>
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Training</th><th>Cohorts</th><th>Status</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.full_name || '—'}</td><td>{u.email}</td>
                <td>
                  <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })} aria-label={`Role for ${u.email}`}>
                    <option value="learner">learner</option><option value="faculty">faculty</option><option value="admin">admin</option>
                  </select>
                </td>
                <td>{u.training_level ?? '—'}</td>
                <td className="small">{u.cohort_members.map((m: any) => `${m.cohorts?.name} (${m.member_role})`).join(', ') || '—'}</td>
                <td>
                  <label className="check"><input type="checkbox" checked={u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} /> active</label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cohorts() {
  const course = useLoad(pocusCourse, []);
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('cohorts').select('*, cohort_members(user_id, member_role, profiles(full_name, email))').order('start_date', { ascending: false, nullsFirst: false });
    if (error) throw error;
    return data as any[];
  }, []);
  const people = useLoad(async () => {
    const { data, error } = await supabase.from('profiles').select('id, full_name, email, role').eq('active', true).order('full_name');
    if (error) throw error;
    return data as any[];
  }, []);
  const [f, setF] = useState({ name: '', academic_year: '2026-2027', block_label: '', start_date: '', end_date: '' });
  const [err, setErr] = useState<unknown>();
  const [add, setAdd] = useState<Record<string, string>>({});

  async function create() {
    setErr(undefined);
    const { error } = await supabase.from('cohorts').insert({ course_id: course.data!.id, ...f, start_date: f.start_date || null, end_date: f.end_date || null });
    if (error) setErr(error);
    else {
      setF({ ...f, name: '', block_label: '' });
      list.reload();
    }
  }
  async function addMember(cohortId: string) {
    const uid = add[cohortId];
    if (!uid) return;
    const p = people.data?.find((x) => x.id === uid);
    const { error } = await supabase.from('cohort_members').insert({ cohort_id: cohortId, user_id: uid, member_role: p?.role === 'learner' ? 'learner' : 'evaluator' });
    if (error) setErr(error);
    list.reload();
  }
  return (
    <div className="stack">
      <section className="card flat">
        <h3>New cohort</h3>
        <div className="formgrid" style={{ alignItems: 'end' }}>
          <label className="field">Name<input type="text" placeholder="POCUS 2026-27 Block 4" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="cohort-name" /></label>
          <label className="field">Academic year<input type="text" value={f.academic_year} onChange={(e) => setF({ ...f, academic_year: e.target.value })} /></label>
          <label className="field">Block<input type="text" value={f.block_label} onChange={(e) => setF({ ...f, block_label: e.target.value })} /></label>
          <label className="field">Start<input type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></label>
          <label className="field">End<input type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></label>
          <button className="btn" disabled={!f.name || !course.data} onClick={create} data-testid="create-cohort">Create cohort</button>
        </div>
        <ErrorNote error={err} />
      </section>
      {list.loading && <Spinner />}
      {!list.loading && !list.data?.length && <Empty>No cohorts yet.</Empty>}
      {(list.data ?? []).map((c) => (
        <section key={c.id} className="panel stack">
          <div className="row between">
            <div><strong>{c.name}</strong> <span className="small muted">{c.academic_year} {c.block_label} · {c.start_date ?? '—'} → {c.end_date ?? '—'}</span></div>
            <button className="btn ghost small" onClick={async () => { await supabase.from('cohorts').update({ archived_at: c.archived_at ? null : new Date().toISOString() }).eq('id', c.id); list.reload(); }}>
              {c.archived_at ? 'Unarchive' : 'Archive'}
            </button>
          </div>
          <div className="chips">
            {c.cohort_members.map((m: any) => (
              <span key={m.user_id} className={`badge ${m.member_role === 'evaluator' ? 'info' : ''}`}>
                {m.profiles?.full_name || m.profiles?.email} · {m.member_role}{' '}
                <button className="btn ghost small" style={{ minHeight: 0, padding: 0 }} aria-label="Remove from cohort"
                  onClick={async () => { await supabase.from('cohort_members').delete().eq('cohort_id', c.id).eq('user_id', m.user_id); list.reload(); }}>✕</button>
              </span>
            ))}
          </div>
          <div className="row">
            <select value={add[c.id] ?? ''} onChange={(e) => setAdd({ ...add, [c.id]: e.target.value })} style={{ maxWidth: 320 }} aria-label="Add member">
              <option value="">Add existing user…</option>
              {(people.data ?? []).filter((p) => !c.cohort_members.some((m: any) => m.user_id === p.id)).map((p) => (
                <option key={p.id} value={p.id}>{p.full_name || p.email} ({p.role})</option>
              ))}
            </select>
            <button className="btn secondary small" onClick={() => addMember(c.id)}>Add</button>
          </div>
        </section>
      ))}
    </div>
  );
}

function Accommodations() {
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('accommodations').select('*, profiles:profiles!accommodations_user_id_fkey(full_name, email), exams(title)').order('created_at', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, []);
  const learners = useLoad(async () => {
    const { data } = await supabase.from('profiles').select('id, full_name, email').eq('role', 'learner').order('full_name');
    return (data ?? []) as any[];
  }, []);
  const exams = useLoad(async () => {
    const { data } = await supabase.from('exams').select('id, title').order('created_at', { ascending: false });
    return (data ?? []) as any[];
  }, []);
  const [f, setF] = useState({ user_id: '', exam_id: '', time_multiplier: 1.5, extra_minutes: 0, extra_attempts: 0, notes: '' });
  const [err, setErr] = useState<unknown>();
  async function add() {
    setErr(undefined);
    const { error } = await supabase.from('accommodations').insert({ ...f, exam_id: f.exam_id || null });
    if (error) setErr(error);
    else list.reload();
  }
  return (
    <div className="stack">
      <div className="notice small">Record only what the exam needs to know (e.g. "1.5× time, approved by PGME"). Do not enter medical details.</div>
      <section className="card flat">
        <div className="formgrid" style={{ alignItems: 'end' }}>
          <label className="field">Learner
            <select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })}>
              <option value="">—</option>{(learners.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.full_name || l.email}</option>)}
            </select>
          </label>
          <label className="field">Exam
            <select value={f.exam_id} onChange={(e) => setF({ ...f, exam_id: e.target.value })}>
              <option value="">All exams</option>{(exams.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </label>
          <label className="field">Time ×<input type="number" min={1} max={4} step={0.25} value={f.time_multiplier} onChange={(e) => setF({ ...f, time_multiplier: Number(e.target.value) })} /></label>
          <label className="field">+ minutes<input type="number" min={0} value={f.extra_minutes} onChange={(e) => setF({ ...f, extra_minutes: Number(e.target.value) })} /></label>
          <label className="field">+ attempts<input type="number" min={0} max={10} value={f.extra_attempts} onChange={(e) => setF({ ...f, extra_attempts: Number(e.target.value) })} /></label>
          <label className="field">Note<input type="text" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <button className="btn" disabled={!f.user_id} onClick={add}>Add</button>
        </div>
        <ErrorNote error={err} />
      </section>
      <div className="tablewrap"><table className="data"><thead><tr><th>Learner</th><th>Exam</th><th>Time</th><th>Extra attempts</th><th>Note</th><th /></tr></thead><tbody>
        {(list.data ?? []).map((a) => (
          <tr key={a.id}>
            <td>{a.profiles?.full_name || a.profiles?.email}</td><td>{a.exams?.title ?? 'All exams'}</td>
            <td>{Number(a.time_multiplier)}×{a.extra_minutes ? ` + ${a.extra_minutes} min` : ''}</td><td>{a.extra_attempts}</td><td>{a.notes}</td>
            <td><button className="btn ghost small" onClick={async () => { await supabase.from('accommodations').delete().eq('id', a.id); list.reload(); }}>Remove</button></td>
          </tr>
        ))}
      </tbody></table></div>
    </div>
  );
}
