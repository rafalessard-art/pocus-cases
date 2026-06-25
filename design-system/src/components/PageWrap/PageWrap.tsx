import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './PageWrap.css';

export interface PageWrapProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** Centered page column (max-width 980px) matching the site's `.wrap`. */
export function PageWrap({ children, className, ...rest }: PageWrapProps) {
  return (
    <div className={cx('pds-wrap', className)} {...rest}>
      {children}
    </div>
  );
}
