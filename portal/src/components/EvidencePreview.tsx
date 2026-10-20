import { useEffect, useState, type ReactNode } from 'react';
import { evidenceUrl } from '../lib/evidence';
import { ErrorNote, Modal, Spinner } from './ui';

/** Private evidence viewer: images inline, PDFs in a frame with an open-in-new-tab fallback. */
export function EvidencePreview({ path, mime, name, onClose, actions }: { path: string; mime: string; name: string; onClose: () => void; actions?: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();
  useEffect(() => {
    evidenceUrl(path).then(setUrl, setErr);
  }, [path]);
  return (
    <Modal title={name} onClose={onClose} wide>
      <ErrorNote error={err} />
      {!url && !err && <Spinner />}
      {url && (
        <div className="stack">
          {mime.startsWith('image/') ? (
            <img src={url} alt={`Evidence: ${name}`} style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', border: '1px solid var(--rule)' }} />
          ) : (
            <iframe src={url} title={`Evidence: ${name}`} style={{ width: '100%', height: '70vh', border: '1px solid var(--rule)', borderRadius: 6 }} />
          )}
          <div className="row">
            {actions}
            <a className="btn secondary small" href={url} target="_blank" rel="noopener noreferrer">Open in new tab</a>
            <span className="small muted">Private link, valid for 10 minutes.</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
