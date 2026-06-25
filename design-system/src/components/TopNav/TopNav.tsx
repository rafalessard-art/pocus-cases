import type { AnchorHTMLAttributes, HTMLAttributes } from 'react';
import { cx } from '../../util/cx';
import './TopNav.css';

export interface TopNavItem {
  /** Link text. */
  label: string;
  /** Target href (hash anchor or route). */
  href: string;
  /** Whether this item is the active section. */
  active?: boolean;
  /** Optional target, e.g. "_blank". */
  target?: AnchorHTMLAttributes<HTMLAnchorElement>['target'];
}

export interface TopNavProps extends HTMLAttributes<HTMLElement> {
  /** Navigation links, left to right. */
  items: TopNavItem[];
}

/** Sticky top navigation bar with an underlined active link. */
export function TopNav({ items, className, ...rest }: TopNavProps) {
  return (
    <nav className={cx('pds-topnav', className)} {...rest}>
      <div className="pds-topnav-inner">
        {items.map((item) => (
          <a
            key={item.href}
            href={item.href}
            target={item.target}
            rel={item.target === '_blank' ? 'noopener' : undefined}
            className={cx(item.active && 'pds-active')}
          >
            {item.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
