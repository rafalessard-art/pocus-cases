import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './Question.css';

export interface QuestionProps extends HTMLAttributes<HTMLElement> {
  /** Uppercase label above the question, e.g. "Question 1". */
  number?: ReactNode;
  /** The question text. */
  question: ReactNode;
  /** Content rendered after the heading — typically an <AnswerKey>. */
  children?: ReactNode;
}

/** A labeled teaching question; place an `AnswerKey` as its children. */
export function Question({ number, question, children, className, ...rest }: QuestionProps) {
  return (
    <section className={cx('pds-qa', className)} {...rest}>
      <h3 className="pds-q">
        {number != null && <span className="pds-qnum">{number}</span>}
        {question}
      </h3>
      {children}
    </section>
  );
}
