import type { ReactNode, DetailsHTMLAttributes } from 'react';
import { cx } from '../../util/cx';
import './AnswerKey.css';

export interface AnswerKeyProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'title'> {
  /** Summary text (the clickable label). Default "Answer key". */
  label?: ReactNode;
  /** Italic hint on the right of the summary. Default "click to collapse / expand". */
  hint?: ReactNode;
  /** Start expanded. */
  defaultOpen?: boolean;
  children?: ReactNode;
}

/** Collapsible answer key built on native `<details>`. */
export function AnswerKey({
  label = 'Answer key',
  hint = 'click to collapse / expand',
  defaultOpen,
  children,
  className,
  ...rest
}: AnswerKeyProps) {
  return (
    <details className={cx('pds-answer', className)} open={defaultOpen} {...rest}>
      <summary>
        <span className="pds-reveal">{label}</span>
        {hint != null && <span className="pds-hint">{hint}</span>}
      </summary>
      <div className="pds-answer-body">{children}</div>
    </details>
  );
}
