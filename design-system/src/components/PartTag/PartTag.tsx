import type { HTMLAttributes, ReactNode } from 'react';
import { cx, accentStyle, type Accent } from '../../util/cx';
import './PartTag.css';

export interface PartTagProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
  /** Solid background accent. Defaults to petrol. */
  accent?: Accent;
}

/** Solid uppercase tag marking a scenario part, e.g. "Part 1 — Assessment". */
export function PartTag({ children, accent, className, style, ...rest }: PartTagProps) {
  return (
    <span className={cx('pds-part-tag', className)} style={{ ...accentStyle(accent), ...style }} {...rest}>
      {children}
    </span>
  );
}
