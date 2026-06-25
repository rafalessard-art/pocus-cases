import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './EvidenceGrade.css';

export interface EvidenceGradeProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
}

/** Small pill chip flagging the strength of evidence, e.g. "Moderate". */
export function EvidenceGrade({ children, className, ...rest }: EvidenceGradeProps) {
  return (
    <span className={cx('pds-evgrade', className)} {...rest}>
      {children}
    </span>
  );
}
