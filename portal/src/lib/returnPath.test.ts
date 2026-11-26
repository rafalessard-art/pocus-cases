import { describe, expect, it } from 'vitest';
import { safeReturnPath } from '../pages/Mfa';

describe('safeReturnPath', () => {
  it('keeps in-app paths', () => {
    expect(safeReturnPath('/faculty')).toBe('/faculty');
    expect(safeReturnPath('/admin/exams/123?tab=x')).toBe('/admin/exams/123?tab=x');
  });
  it('refuses anything that could leave the app', () => {
    for (const v of ['//evil.example', '/\\evil.example', '/\\/evil', 'https://evil.example', 'javascript:alert(1)', '', null, undefined, 42, { a: 1 }]) {
      expect(safeReturnPath(v)).toBe('/');
    }
  });
});
