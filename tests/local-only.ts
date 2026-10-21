/**
 * The automated tests create fictional users, demo exams and synthetic evidence,
 * and the end-to-end suite can reset the database. They must only ever run
 * against a local stack, never a hosted (preview or production) database or site.
 */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

export function assertLocal(what: string, value: string | undefined) {
  if (!value) return;
  let host = '';
  try { host = new URL(value).hostname; } catch { throw new Error(`${what} is not a valid URL`); }
  if (!LOCAL.test(host)) {
    throw new Error(`${what} points at ${host}. The tests write fictional data and may reset the database, so they only run against a local stack.`);
  }
}
