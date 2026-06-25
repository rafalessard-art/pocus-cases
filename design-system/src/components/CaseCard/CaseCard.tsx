import type { ReactNode } from 'react';
import { cx, accentStyle, type Accent } from '../../util/cx';
import { NumBadge } from '../NumBadge';
import { Tag } from '../Tag';
import './CaseCard.css';

export interface CaseCardProps {
  /** Accent color for the top border, badge, topic, and action link. */
  accent?: Accent;
  /** Badge content (typically the case number). */
  number?: ReactNode;
  /** Uppercase topic eyebrow. */
  topic?: ReactNode;
  /** Card heading. */
  title: ReactNode;
  /** Body description. */
  description?: ReactNode;
  /** Footer metadata (left), e.g. "2-part scenario". */
  tags?: ReactNode;
  /** Footer action text (right). Defaults to "Open case →" (or "Coming soon" when `soon`). */
  action?: ReactNode;
  /** Destination link. When set, the card renders as an anchor. Ignored when `soon`. */
  href?: string;
  /** Render the dashed "in development" placeholder variant. */
  soon?: boolean;
  className?: string;
}

/** Accent-themed case card. Renders as a link, or a dashed placeholder when `soon`. */
export function CaseCard({
  accent,
  number,
  topic,
  title,
  description,
  tags,
  action,
  href,
  soon = false,
  className,
}: CaseCardProps) {
  const inner = (
    <>
      <div className="pds-card-body">
        {(number != null || topic != null) && (
          <div className="pds-badge-row">
            {number != null && <NumBadge>{number}</NumBadge>}
            {topic != null && <Tag variant="topic">{topic}</Tag>}
          </div>
        )}
        <h2>{title}</h2>
        {description != null && <p>{description}</p>}
      </div>
      <div className="pds-card-foot">
        <Tag variant="meta">{tags}</Tag>
        <span className="pds-open">{action ?? (soon ? 'Coming soon' : 'Open case →')}</span>
      </div>
    </>
  );

  const classes = cx('pds-card', soon && 'pds-card--soon', className);
  const style = accentStyle(accent);

  if (soon || !href) {
    return (
      <div className={classes} style={style}>
        {inner}
      </div>
    );
  }
  return (
    <a className={classes} style={style} href={href}>
      {inner}
    </a>
  );
}
