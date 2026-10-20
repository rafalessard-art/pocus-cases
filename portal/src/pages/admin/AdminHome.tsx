import { Link } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { useLoad } from '../../components/ui';
import { supabase } from '../../lib/supabase';

async function count(table: string, filter?: (q: any) => any) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n } = await q;
  return n ?? 0;
}

export function AdminHome() {
  const c = useLoad(async () => ({
    media: await count('media_assets', (q) => q.is('archived_at', null)),
    mediaTodo: await count('media_assets', (q) => q.is('archived_at', null).or('authorization_status.neq.authorized,deidentified.eq.false')),
    questions: await count('questions', (q) => q.is('archived_at', null)),
    exams: await count('exams'),
    people: await count('profiles', (q) => q.eq('active', true)),
    invites: await count('invitations', (q) => q.is('accepted_at', null).is('revoked_at', null)),
  }), []);
  const d = c.data;
  const tiles = [
    { to: '/admin/exams', title: 'Examinations', body: 'Build, version, publish and assign exams.', stat: d?.exams, label: 'exams', accent: 'var(--clay)' },
    { to: '/admin/questions', title: 'Question bank', body: 'Versioned questions mapped to domains and objectives.', stat: d?.questions, label: 'questions', accent: 'var(--petrol)' },
    { to: '/admin/media', title: 'Media library', body: 'Upload and govern ultrasound loops and stills.', stat: d?.media, label: `clips · ${d?.mediaTodo ?? 0} need review`, accent: 'var(--sky)' },
    { to: '/admin/people', title: 'People & cohorts', body: 'Invitations, roles, rotation cohorts, accommodations.', stat: d?.people, label: `active · ${d?.invites ?? 0} pending invites`, accent: 'var(--moss)' },
    { to: '/admin/import', title: 'Import', body: 'Migrate an existing exam from CSV/JSON with validation.', stat: undefined, label: '', accent: 'var(--gold)' },
  ];
  return (
    <Page kicker="Administration" title="Admin" subtitle="Content, people and governance">
      <div className="grid">
        {tiles.map((t) => (
          <Link key={t.to} to={t.to} className="card" style={{ textDecoration: 'none', color: 'inherit', ['--accent' as any]: t.accent }}>
            <h3>{t.title}</h3>
            <p className="small muted">{t.body}</p>
            {t.stat !== undefined && <div className="stat"><b>{t.stat}</b><span>{t.label}</span></div>}
          </Link>
        ))}
      </div>
      <div className="footer-note">
        Development build — not institutionally approved for live assessment data. See <span className="mono">docs/exam-platform/PRIVACY_AND_GOVERNANCE.md</span> before use with real learners or clinical images.
      </div>
    </Page>
  );
}
