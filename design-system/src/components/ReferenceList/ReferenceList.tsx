import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './ReferenceList.css';

export interface Reference {
  /** Bold lead text (authors / title). */
  title: ReactNode;
  /** Muted trailing detail (journal, year, etc.). */
  detail?: ReactNode;
  /** Optional source link, shown after the detail. */
  href?: string;
}

export interface ReferenceListProps extends HTMLAttributes<HTMLOListElement> {
  /** Ordered references; numbering is automatic. */
  items: Reference[];
}

/** Auto-numbered reference list with bold titles and muted detail. */
export function ReferenceList({ items, className, ...rest }: ReferenceListProps) {
  return (
    <ol className={cx('pds-ref-list', className)} {...rest}>
      {items.map((ref, i) => (
        <li key={i}>
          <span className="pds-ref-title">{ref.title}</span>
          {ref.detail != null && <span className="pds-ref-detail"> {ref.detail}</span>}
          {ref.href && (
            <>
              {' '}
              <a href={ref.href} target="_blank" rel="noopener">
                {ref.href}
              </a>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
