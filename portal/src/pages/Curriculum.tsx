import { useState } from 'react';
import { Page } from '../components/Layout';
import { Badge, ErrorNote, Spinner, useLoad } from '../components/ui';
import { useAuth } from '../lib/auth';
import { rpc, supabase } from '../lib/supabase';

type Item = {
  id: string; section: string; kind: string; title: string; description: string; url: string | null;
  required: boolean; objective_codes: string[]; completed_at: string | null;
};

const KIND: Record<string, string> = {
  case: 'Teaching case', tool: 'Interactive tool', article: 'Article', video: 'Video', reference: 'Reference',
  exam: 'Examination', overview: 'Overview', other: 'Resource',
};

export function Curriculum() {
  const { profile } = useAuth();
  const { data, error, loading, setData } = useLoad(() => rpc<any>('my_curriculum', { p_course_slug: 'pocus' }), []);
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(item: Item) {
    if (!profile) return;
    setBusy(item.id);
    if (item.completed_at) await supabase.from('curriculum_progress').delete().eq('item_id', item.id).eq('user_id', profile.id);
    else await supabase.from('curriculum_progress').insert({ item_id: item.id, user_id: profile.id });
    const fresh = await rpc<any>('my_curriculum', { p_course_slug: 'pocus' });
    setData(fresh);
    setBusy(null);
  }

  if (loading) return <Spinner />;
  if (error) return <div className="wrap"><ErrorNote error={error} /></div>;
  const items: Item[] = data.items;
  const sections = [...new Set(items.map((i) => i.section))];
  const objectives: any[] = data.objectives;
  const domains: any[] = data.domains;

  return (
    <Page kicker="POCUS Rotation" title="Curriculum" subtitle={data.course.description}>
      <div className="split">
        <div>
          {sections.map((s) => (
            <section key={s}>
              <p className="seclabel">{s}</p>
              <div className="stack">
                {items.filter((i) => i.section === s).map((i) => (
                  <div key={i.id} className="panel row between" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <Badge tone="info">{KIND[i.kind] ?? i.kind}</Badge>
                        {i.required ? <Badge tone="petrol">Required</Badge> : <Badge>Optional</Badge>}
                        {i.objective_codes.map((c) => <span key={c} className="mono muted">{c}</span>)}
                      </div>
                      <h3 style={{ margin: '8px 0 4px' }}>
                        {i.url ? <a href={i.url} target={i.url.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{i.title}</a> : i.title}
                      </h3>
                      {i.description && <p className="small muted" style={{ margin: 0 }}>{i.description}</p>}
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={!!i.completed_at} disabled={busy === i.id} onChange={() => toggle(i)} />
                      Completed
                    </label>
                  </div>
                ))}
              </div>
            </section>
          ))}
          <p className="seclabel">End-of-block examination</p>
          <div className="panel">
            Your assigned examination appears under <a href="/app/exams">Examinations</a>. Exam questions are mapped to the
            learning objectives on the right, so your results show which domains to review.
          </div>
        </div>
        <aside>
          <p className="seclabel">Learning objectives</p>
          {domains.map((d) => {
            const objs = objectives.filter((o) => o.domain_key === d.key);
            if (!objs.length) return null;
            return (
              <div key={d.key} style={{ marginBottom: 14 }}>
                <h3 style={{ fontSize: 15 }}>{d.label}</h3>
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                  {objs.map((o) => (
                    <li key={o.id}><span className="mono">{o.code}</span> {o.title}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        </aside>
      </div>
    </Page>
  );
}
