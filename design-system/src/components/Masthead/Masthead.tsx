import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './Masthead.css';

export interface MastheadStat {
  /** Emphasized figure, e.g. "4". */
  value: ReactNode;
  /** Trailing label, e.g. "cases available". */
  label: ReactNode;
}

export interface MastheadProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Small uppercase eyebrow above the title. */
  kicker?: ReactNode;
  /** Main page title. */
  title: ReactNode;
  /** Italic subtitle beneath the title. */
  subtitle?: ReactNode;
  /** Optional stat chips rendered as a row. */
  stats?: MastheadStat[];
}

/** Page masthead: kicker, headline, subtitle, and optional stats row. */
export function Masthead({ kicker, title, subtitle, stats, className, ...rest }: MastheadProps) {
  return (
    <header className={cx('pds-masthead', className)} {...rest}>
      {kicker != null && <p className="pds-kicker">{kicker}</p>}
      <h1>{title}</h1>
      {subtitle != null && <p className="pds-subtitle">{subtitle}</p>}
      {stats && stats.length > 0 && (
        <div className="pds-stats">
          {stats.map((s, i) => (
            <span key={i}>
              <b>{s.value}</b> {s.label}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}
