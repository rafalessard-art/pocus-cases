import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './Pearl.css';

export interface PearlProps extends HTMLAttributes<HTMLDivElement> {
  /** Uppercase label. Default "Clinical pearl". */
  label?: ReactNode;
  children?: ReactNode;
}

/** Highlighted "clinical pearl" callout with a warm gradient and clay edge. */
export function Pearl({ label = 'Clinical pearl', children, className, ...rest }: PearlProps) {
  return (
    <div className={cx('pds-pearl', className)} {...rest}>
      {label != null && <span className="pds-pearl-label">{label}</span>}
      {children}
    </div>
  );
}
