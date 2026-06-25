/** Join class names, dropping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

import type { CSSProperties } from 'react';

/** Accent colors available across the system (canonical token names). */
export type Accent = 'petrol' | 'clay' | 'moss' | 'sky' | 'gold';

/** Maps an accent name to the CSS custom property the components read. */
export function accentStyle(accent?: Accent): CSSProperties {
  return accent ? ({ ['--accent']: `var(--${accent})` } as CSSProperties) : {};
}
