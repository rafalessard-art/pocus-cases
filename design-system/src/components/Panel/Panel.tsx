import type { HTMLAttributes, ReactNode } from 'react';
import { cx, accentStyle, type Accent } from '../../util/cx';
import './Panel.css';

export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Uppercase panel heading. */
  title?: ReactNode;
  /** Accent for the left border and heading. Defaults to gold. */
  accent?: Accent;
  children?: ReactNode;
}

/** Bordered info panel with an accent left edge — the About / Resources / note boxes. */
export function Panel({ title, accent, children, className, style, ...rest }: PanelProps) {
  return (
    <div className={cx('pds-panel', className)} style={{ ...accentStyle(accent), ...style }} {...rest}>
      {title != null && <h3 className="pds-panel-title">{title}</h3>}
      {children}
    </div>
  );
}
