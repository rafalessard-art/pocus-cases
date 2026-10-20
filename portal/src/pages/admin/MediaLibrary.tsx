import { useEffect, useMemo, useRef, useState } from 'react';
import { Page } from '../../components/Layout';
import { UltrasoundPlayer } from '../../components/UltrasoundPlayer';
import { Badge, Empty, ErrorNote, Modal, Spinner, fmtDate, useLoad } from '../../components/ui';
import { AUTH_LABEL, domains as loadDomains, mediaLibrary, mediaReady, pocusCourse, type Domain, type MediaAsset, type MediaVersion } from '../../lib/content';
import { ACCEPTED, NEEDS_CONVERSION, formatBytes, keyFromFilename, sha256, signedUrls } from '../../lib/media';
import { supabase } from '../../lib/supabase';
import { uploadMedia } from '../../lib/upload';

type QueueItem = {
  id: string;
  file: File;
  mediaKey: string;
  title: string;
  status: 'ready' | 'blocked' | 'uploading' | 'done' | 'error';
  progress: number;
  message?: string;
  duplicateOf?: string;
};

const CONVERT_CMD = 'tools/convert-clips.sh <input files>   # → H.264 MP4, metadata stripped';

export function MediaLibrary() {
  const course = useLoad(pocusCourse, []);
  const doms = useLoad(() => (course.data ? loadDomains(course.data.id) : Promise.resolve([] as Domain[])), [course.data?.id]);
  const lib = useLoad(mediaLibrary, []);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [batch, setBatch] = useState({ domainKey: '', source: '', attribution: '', license: '' });
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [fDomain, setFDomain] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<MediaAsset | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const input = useRef<HTMLInputElement>(null);

  const assets = lib.data ?? [];
  const hashes = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of assets) if (a.current?.sha256) m.set(a.current.sha256, a.media_key);
    return m;
  }, [assets]);

  const filtered = assets.filter(
    (a) =>
      (showArchived || !a.archived_at) &&
      (!fDomain || a.domain_key === fDomain) &&
      (!fStatus || (fStatus === 'ready' ? mediaReady(a) : !mediaReady(a))) &&
      (!q || `${a.media_key} ${a.title} ${a.description} ${a.tags.join(' ')} ${a.current?.original_filename ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  );

  useEffect(() => {
    const paths = filtered.slice(0, 60).map((a) => a.current?.storage_path).filter(Boolean) as string[];
    if (paths.length) signedUrls(paths).then(setThumbs).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.data, fDomain, fStatus, q, showArchived]);

  async function addFiles(files: FileList | File[]) {
    const items: QueueItem[] = [];
    for (const f of Array.from(files)) {
      const id = `${f.name}-${f.size}-${f.lastModified}`;
      if (queue.some((x) => x.id === id)) continue;
      const it: QueueItem = { id, file: f, mediaKey: keyFromFilename(f.name), title: f.name.replace(/\.[^.]+$/, ''), status: 'ready', progress: 0 };
      if (NEEDS_CONVERSION.test(f.name) || (!ACCEPTED.includes(f.type) && !/\.(mp4|webm|png|jpe?g|gif|webp)$/i.test(f.name))) {
        it.status = 'blocked';
        it.message = 'Format not playable in all browsers. Convert to H.264 MP4 first (see the media guide).';
      } else if (f.size > 200 * 1024 * 1024) {
        it.status = 'blocked';
        it.message = 'Larger than 200 MB. Trim the loop or re-encode (short loops are usually under 10 MB).';
      } else {
        try {
          const h = await sha256(f);
          if (hashes.has(h)) {
            it.duplicateOf = hashes.get(h);
            it.message = `Identical file already in the library as ${hashes.get(h)}.`;
          }
        } catch {
          /* hashing is advisory */
        }
      }
      items.push(it);
    }
    setQueue((qq) => [...qq, ...items]);
  }

  async function uploadAll() {
    setBusy(true);
    for (const it of queue) {
      if (it.status !== 'ready') continue;
      setQueue((qq) => qq.map((x) => (x.id === it.id ? { ...x, status: 'uploading', progress: 0, message: undefined } : x)));
      try {
        await uploadMedia(
          it.file,
          {
            mediaKey: it.mediaKey,
            title: it.title,
            domainKey: batch.domainKey || null,
            source: batch.source,
            attribution: batch.attribution,
            license: batch.license,
            courseId: course.data?.id,
          },
          (p) => setQueue((qq) => qq.map((x) => (x.id === it.id ? { ...x, progress: p } : x))),
        );
        setQueue((qq) => qq.map((x) => (x.id === it.id ? { ...x, status: 'done', progress: 100, message: undefined } : x)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setQueue((qq) =>
          qq.map((x) => (x.id === it.id ? { ...x, status: 'error', message: /duplicate key|media_key/.test(msg) ? `Media key "${it.mediaKey}" already exists — rename it.` : msg } : x)),
        );
      }
    }
    setBusy(false);
    lib.reload();
  }

  const domainLabel = (k: string | null) => doms.data?.find((d) => d.key === k)?.label ?? (k || 'No domain');

  return (
    <Page kicker="Administration" title="Ultrasound media library" subtitle="Private, versioned clips and images for examinations">
      <div className="notice warn" style={{ marginBottom: 18 }}>
        Upload only media that is <strong>de-identified</strong> (no burned-in names, MRNs, dates of birth or institution labels; metadata stripped)
        and <strong>authorized for educational use</strong>. Clips cannot be published in an exam until both are confirmed on the clip.
      </div>

      <section className="card flat" aria-labelledby="up-h">
        <h3 id="up-h">Upload clips and images</h3>
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void addFiles(e.dataTransfer.files);
          }}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        >
          <strong>Drop files here or click to choose</strong>
          <div className="small muted">MP4 (H.264) or WebM loops · PNG, JPEG, GIF, WebP stills · up to 200 MB each · multiple files allowed</div>
          <input ref={input} type="file" multiple accept="video/mp4,video/webm,image/png,image/jpeg,image/gif,image/webp,.mov,.avi" hidden
            onChange={(e) => e.target.files && addFiles(e.target.files)} data-testid="media-file-input" />
        </div>
        {queue.length > 0 && (
          <div className="stack" style={{ marginTop: 16 }}>
            <div className="formgrid">
              <label className="field">
                Domain for this batch
                <select value={batch.domainKey} onChange={(e) => setBatch({ ...batch, domainKey: e.target.value })} data-testid="batch-domain">
                  <option value="">— choose —</option>
                  {doms.data?.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              </label>
              <label className="field">Source<input type="text" value={batch.source} placeholder="e.g. TOH POCUS teaching archive" onChange={(e) => setBatch({ ...batch, source: e.target.value })} /></label>
              <label className="field">Attribution<input type="text" value={batch.attribution} onChange={(e) => setBatch({ ...batch, attribution: e.target.value })} /></label>
              <label className="field">Licence / permission<input type="text" value={batch.license} placeholder="e.g. Departmental permission 2026-10" onChange={(e) => setBatch({ ...batch, license: e.target.value })} /></label>
            </div>
            <div className="tablewrap">
              <table className="data">
                <thead><tr><th>File</th><th>Media key</th><th>Title</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {queue.map((it) => (
                    <tr key={it.id}>
                      <td><div>{it.file.name}</div><div className="small muted">{formatBytes(it.file.size)}</div></td>
                      <td><input type="text" value={it.mediaKey} disabled={it.status !== 'ready' && it.status !== 'error'}
                        onChange={(e) => setQueue((qq) => qq.map((x) => (x.id === it.id ? { ...x, mediaKey: e.target.value.replace(/[^A-Za-z0-9._-]/g, '-'), status: x.status === 'error' ? 'ready' : x.status } : x)))} /></td>
                      <td><input type="text" value={it.title} disabled={it.status !== 'ready' && it.status !== 'error'}
                        onChange={(e) => setQueue((qq) => qq.map((x) => (x.id === it.id ? { ...x, title: e.target.value } : x)))} /></td>
                      <td style={{ minWidth: 200 }}>
                        {it.status === 'uploading' && <div className="bar"><span style={{ width: `${it.progress}%` }} /></div>}
                        {it.status === 'done' && <Badge tone="ok">Uploaded</Badge>}
                        {it.status === 'blocked' && <Badge tone="bad">Needs conversion</Badge>}
                        {it.status === 'error' && <Badge tone="bad">Error</Badge>}
                        {it.status === 'ready' && <Badge tone="info">Ready</Badge>}
                        {it.message && <div className="small muted" style={{ marginTop: 4 }}>{it.message}</div>}
                        {it.status === 'blocked' && <div className="mono small" style={{ marginTop: 4 }}>{CONVERT_CMD}</div>}
                      </td>
                      <td>
                        {it.status !== 'uploading' && (
                          <button className="btn ghost small" onClick={() => setQueue((qq) => qq.filter((x) => x.id !== it.id))} aria-label={`Remove ${it.file.name}`}>✕</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row">
              <button className="btn" onClick={uploadAll} disabled={busy || !queue.some((x) => x.status === 'ready')} data-testid="upload-all">
                {busy ? 'Uploading…' : `Upload ${queue.filter((x) => x.status === 'ready').length} file(s)`}
              </button>
              <button className="btn secondary" onClick={() => setQueue((qq) => qq.filter((x) => x.status === 'uploading'))} disabled={busy}>Clear list</button>
            </div>
          </div>
        )}
      </section>

      <p className="seclabel">Library ({filtered.length})</p>
      <div className="row" style={{ marginBottom: 14 }}>
        <input type="search" placeholder="Search key, title, tag, filename…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} aria-label="Search media" />
        <select value={fDomain} onChange={(e) => setFDomain(e.target.value)} style={{ maxWidth: 240 }} aria-label="Filter by domain">
          <option value="">All domains</option>
          {doms.data?.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} style={{ maxWidth: 220 }} aria-label="Filter by status">
          <option value="">Any status</option>
          <option value="ready">Ready for exams</option>
          <option value="todo">Needs review</option>
        </select>
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
      </div>
      {lib.loading ? <Spinner /> : <ErrorNote error={lib.error} />}
      {!lib.loading && !filtered.length && <Empty>No media yet. Upload clips above.</Empty>}
      <div className="grid">
        {filtered.map((a) => (
          <div key={a.id} className="card mediacard" onClick={() => setOpen(a)} role="button" tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setOpen(a)} data-testid="media-card">
            <div className="thumb">
              {a.current && thumbs[a.current.storage_path] ? (
                a.kind === 'video' ? <video src={`${thumbs[a.current.storage_path]}#t=0.1`} muted preload="metadata" /> : <img src={thumbs[a.current.storage_path]} alt="" />
              ) : <span className="small" style={{ color: '#888' }}>{a.current?.upload_status ?? 'no file'}</span>}
            </div>
            <div className="row between" style={{ marginTop: 8 }}>
              <strong className="mono">{a.media_key}</strong>
              {mediaReady(a) ? <Badge tone="ok">Ready</Badge> : <Badge tone="warn">{a.archived_at ? 'Archived' : !a.deidentified ? 'De-ID needed' : AUTH_LABEL[a.authorization_status]}</Badge>}
            </div>
            <div className="small">{a.title}</div>
            <div className="small muted">{domainLabel(a.domain_key)} · {a.kind} · v{a.current?.version ?? '—'}</div>
          </div>
        ))}
      </div>
      {open && <AssetModal asset={open} domains={doms.data ?? []} onClose={() => setOpen(null)} onChanged={() => lib.reload()} />}
    </Page>
  );
}

function AssetModal({ asset, domains, onClose, onChanged }: { asset: MediaAsset; domains: Domain[]; onClose: () => void; onChanged: () => void }) {
  const [a, setA] = useState(asset);
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const [replacing, setReplacing] = useState<number | null>(null);
  const versions = useLoad(async () => {
    const { data, error } = await supabase.from('media_versions').select('*').eq('asset_id', asset.id).order('version', { ascending: false });
    if (error) throw error;
    return data as MediaVersion[];
  }, [asset.id, a.current_version_id]);
  const usedIn = useLoad(async () => {
    const ids = (versions.data ?? []).map((v) => v.id);
    if (!ids.length) return [];
    const { data, error } = await supabase.from('question_version_media').select('question_version_id, question_versions(question_id, version, stem, locked)').in('media_version_id', ids);
    if (error) throw error;
    return data as any[];
  }, [versions.data]);
  const current = versions.data?.find((v) => v.id === a.current_version_id);

  useEffect(() => {
    if (current?.storage_path) signedUrls([current.storage_path]).then((u) => setUrl(u[current.storage_path])).catch(setErr);
  }, [current?.storage_path]);

  async function save(patch: Partial<MediaAsset>) {
    setErr(undefined);
    setSaved(false);
    const before = a;
    setA({ ...a, ...patch }); // optimistic; reverted on error
    const { data, error } = await supabase.from('media_assets').update(patch).eq('id', a.id).select('*').single();
    if (error) {
      setA(before);
      setErr(error);
    }
    else {
      setA({ ...a, ...data });
      setSaved(true);
      onChanged();
    }
  }

  async function replace(file: File) {
    setErr(undefined);
    setReplacing(0);
    try {
      await uploadMedia(file, { assetId: a.id }, (p) => setReplacing(p));
      const { data } = await supabase.from('media_assets').select('*').eq('id', a.id).single();
      setA({ ...a, ...data });
      onChanged();
    } catch (e) {
      setErr(e);
    }
    setReplacing(null);
  }

  return (
    <Modal title={`${a.media_key}`} onClose={onClose} wide>
      <div className="grid two">
        <div className="stack">
          {current ? (
            <UltrasoundPlayer src={url} kind={a.kind} width={current.width} height={current.height} frameRate={current.frame_rate} caption={a.title} />
          ) : <Empty>No uploaded version.</Empty>}
          {current && (
            <dl className="kv small">
              <dt>File</dt><dd>{current.original_filename}</dd>
              <dt>Format</dt><dd>{current.mime_type} · {current.width}×{current.height}{current.duration_seconds ? ` · ${Number(current.duration_seconds).toFixed(2)} s` : ''}</dd>
              <dt>Size</dt><dd>{formatBytes(current.size_bytes)}</dd>
              <dt>Version</dt><dd>v{current.version} · uploaded {fmtDate(current.uploaded_at)}</dd>
              <dt>SHA-256</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{current.sha256 ?? '—'}</dd>
              <dt>Stable ID</dt><dd className="mono">{a.id}</dd>
            </dl>
          )}
        </div>
        <div className="stack">
          <label className="field">Title<input type="text" value={a.title} onChange={(e) => setA({ ...a, title: e.target.value })} /></label>
          <label className="field">Description<textarea value={a.description} onChange={(e) => setA({ ...a, description: e.target.value })} /></label>
          <div className="formgrid">
            <label className="field">Domain
              <select value={a.domain_key ?? ''} onChange={(e) => setA({ ...a, domain_key: e.target.value || null })}>
                <option value="">—</option>
                {domains.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </label>
            <label className="field">Tags <span className="hint">comma-separated</span>
              <input type="text" value={a.tags.join(', ')} onChange={(e) => setA({ ...a, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
            </label>
            <label className="field">Source<input type="text" value={a.source} onChange={(e) => setA({ ...a, source: e.target.value })} /></label>
            <label className="field">Attribution<input type="text" value={a.attribution} onChange={(e) => setA({ ...a, attribution: e.target.value })} /></label>
            <label className="field">Licence / permission<input type="text" value={a.license} onChange={(e) => setA({ ...a, license: e.target.value })} /></label>
          </div>
          <button className="btn secondary" onClick={() => save({ title: a.title, description: a.description, domain_key: a.domain_key, tags: a.tags, source: a.source, attribution: a.attribution, license: a.license })}>
            Save details
          </button>
          <div className="panel stack">
            <strong>Governance</strong>
            <label className="field">Authorization for educational use
              <select value={a.authorization_status} onChange={(e) => save({ authorization_status: e.target.value as MediaAsset['authorization_status'] })} data-testid="auth-status">
                <option value="pending">Pending</option>
                <option value="authorized">Authorized</option>
                <option value="restricted">Restricted</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={a.deidentified} onChange={(e) => save({ deidentified: e.target.checked })} data-testid="deid-check" />
              I have reviewed every frame: no burned-in patient identifiers, and file metadata has been stripped.
            </label>
            {a.deidentified && a.deidentified_at && <span className="small muted">Attested {fmtDate(a.deidentified_at)}</span>}
          </div>
          {saved && <div className="notice ok small">Saved.</div>}
          <ErrorNote error={err} />
          <div className="row">
            <label className="btn secondary small">
              {replacing !== null ? `Uploading ${replacing}%…` : 'Replace with new version…'}
              <input type="file" hidden accept={a.kind === 'video' ? 'video/mp4,video/webm' : 'image/*'} onChange={(e) => e.target.files?.[0] && replace(e.target.files[0])} />
            </label>
            <button className="btn ghost small" onClick={() => save({ archived_at: a.archived_at ? null : new Date().toISOString() } as Partial<MediaAsset>)}>
              {a.archived_at ? 'Unarchive' : 'Archive'}
            </button>
          </div>
          <p className="small muted">Replacing creates a new version. Questions in published exams keep the version learners saw; drafts can be updated.</p>
        </div>
      </div>
      <p className="seclabel">Versions</p>
      <div className="tablewrap"><table className="data"><thead><tr><th>v</th><th>File</th><th>Status</th><th>Uploaded</th></tr></thead><tbody>
        {(versions.data ?? []).map((v) => (
          <tr key={v.id}><td>{v.version}{v.id === a.current_version_id && ' (current)'}</td><td>{v.original_filename}</td>
            <td>{v.upload_status}{v.error ? ` — ${v.error}` : ''}</td><td>{fmtDate(v.uploaded_at ?? v.created_at)}</td></tr>
        ))}
      </tbody></table></div>
      <p className="seclabel">Used in questions</p>
      {(usedIn.data ?? []).length === 0 ? <p className="small muted">Not linked to any question yet.</p> : (
        <ul className="small">{(usedIn.data ?? []).map((u: any) => (
          <li key={u.question_version_id}>v{u.question_versions?.version}{u.question_versions?.locked ? ' (published)' : ''}: <a href={`/app/admin/questions/${u.question_versions?.question_id}`}>{u.question_versions?.stem?.slice(0, 90)}</a></li>
        ))}</ul>
      )}
    </Modal>
  );
}
