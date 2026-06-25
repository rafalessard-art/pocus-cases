import type { HTMLAttributes, ReactNode } from 'react';
import { cx, accentStyle, type Accent } from '../../util/cx';
import './Tag.css';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
  /**
   * `topic` — uppercase accent label (card badge row).
   * `meta` — muted small text (card footer). Default `topic`.
   */
  variant?: 'topic' | 'meta';
  /** Accent for the `topic` variant; inherits `--accent` if omitted. */
  accent?: Accent;
}

/** Small inline label: a colored topic eyebrow or muted metadata text. */
export function Tag({ children, variant = 'topic', accent, className, style, ...rest }: TagProps) {
  return (
    <span
      className={cx(`pds-tag--${variant}`, className)}
      style={variant === 'topic' ? { ...accentStyle(accent), ...style } : style}
      {...rest}
    >
      {children}
    </span>
  );
}
