import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './Figure.css';

export interface FigureProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Bold caption above the media. */
  title?: ReactNode;
  /** Image source. If set, an <img> is rendered; otherwise pass media as children. */
  src?: string;
  /** Alt text for `src`. */
  alt?: string;
  /** Italic description below the media. */
  desc?: ReactNode;
  /** Attribution / source line (rendered smallest). */
  attribution?: ReactNode;
  /** Custom media (SVG, video, etc.) when not using `src`. */
  children?: ReactNode;
}

/** Captioned figure: optional title, an image or custom media, description, and attribution. */
export function Figure({ title, src, alt, desc, attribution, children, className, ...rest }: FigureProps) {
  return (
    <figure className={cx('pds-figure', className)} {...rest}>
      {title != null && <div className="pds-figtitle">{title}</div>}
      {src ? <img src={src} alt={alt ?? ''} /> : children}
      {desc != null && <figcaption className="pds-figdesc">{desc}</figcaption>}
      {attribution != null && <div className="pds-attr">{attribution}</div>}
    </figure>
  );
}
