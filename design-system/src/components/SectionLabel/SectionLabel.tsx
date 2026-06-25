import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './SectionLabel.css';

export interface SectionLabelProps extends HTMLAttributes<HTMLParagraphElement> {
  children?: ReactNode;
  /** Show the gradient underline rule (default true). */
  rule?: boolean;
}

/** Uppercase section eyebrow with an optional gradient rule beneath it. */
export function SectionLabel({ children, rule = true, className, ...rest }: SectionLabelProps) {
  return (
    <p className={cx('pds-seclabel', className)} {...rest}>
      {children}
      {rule && <span className="pds-rule" />}
    </p>
  );
}
