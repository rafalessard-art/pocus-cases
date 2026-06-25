import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './Vignette.css';

export interface VignetteProps extends HTMLAttributes<HTMLDivElement> {
  /** Uppercase heading inside the card (the `.vh` line). */
  heading?: ReactNode;
  /** Crisis styling — red left edge and heading. */
  crisis?: boolean;
  children?: ReactNode;
}

/** Clinical-vignette card with an accent left edge; `crisis` switches it to red. */
export function Vignette({ heading, crisis = false, children, className, ...rest }: VignetteProps) {
  return (
    <div className={cx('pds-vignette', crisis && 'pds-vignette--crisis', className)} {...rest}>
      {heading != null && <p className="pds-vh">{heading}</p>}
      {children}
    </div>
  );
}
