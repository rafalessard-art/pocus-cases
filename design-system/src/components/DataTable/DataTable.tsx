import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../../util/cx';
import './DataTable.css';

export interface DataTableProps extends HTMLAttributes<HTMLElement> {
  /** Column headers. */
  columns?: ReactNode[];
  /** Row data, each an array of cells aligned to `columns`. */
  rows?: ReactNode[][];
  /** Italic caption beneath the table. */
  caption?: ReactNode;
  /** Provide a fully custom `<table>` instead of `columns`/`rows`. */
  children?: ReactNode;
}

/** Styled data table (petrol header, zebra rows) wrapped in a scrollable figure. */
export function DataTable({ columns, rows, caption, children, className, ...rest }: DataTableProps) {
  return (
    <figure className={cx('pds-tbl', className)} {...rest}>
      {children ?? (
        <table>
          {columns && columns.length > 0 && (
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {(rows ?? []).map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {caption != null && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
