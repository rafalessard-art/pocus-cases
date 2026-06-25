import type { HTMLAttributes, ReactNode } from 'react';
import { cx, accentStyle, type Accent } from '../../util/cx';
import './NumBadge.css';

export interface NumBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
  /** Circle (default, for single numbers) or pill (for short labels). */
  shape?: 'circle' | 'pill';
  /**
   * Accent color. Omit to inherit the `--accent` CSS variable from a parent
   * (e.g. a CaseCard), which is how the cards theme their badge.
   */
  accent?: Accent;
}

/** Numbered badge — a filled circle or pill in the accent color. */
export function NumBadge({ children, shape = 'circle', accent, className, style, ...rest }: NumBadgeProps) {
  return (
    <span
      className={cx('pds-num', `pds-num--${shape}`, className)}
      style={{ ...accentStyle(accent), ...style }}
      {...rest}
    >
      {children}
    </span>
  );
}
