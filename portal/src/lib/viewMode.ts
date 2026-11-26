import { useSyncExternalStore } from 'react';

/**
 * How the interface is being viewed — never what the session may do.
 *
 * - perspective: which part of the portal a reviewer (or the owner) is looking at.
 * - actingLearner: the fictional resident shown in the Resident perspective. The
 *   learner read functions receive it as p_as_learner; the database checks that it
 *   is a fictional resident and that the caller is a reviewer or the owner.
 * - previewAsReviewer: the owner is previewing the reviewer experience. Requests then
 *   carry `x-portal-preview: reviewer`, which the database honours only to *lower* an
 *   administrator to the reviewer role.
 * - readOnly: the interface disables writes (reviewers, owner previews, and the owner
 *   viewing a fictional resident). The database enforces this for reviewers; for the
 *   owner's previews the guard below is what keeps their own admin rights unused.
 */
export type Perspective = 'resident' | 'faculty' | 'admin';
export type ViewState = {
  perspective: Perspective | null;
  actingLearner: { id: string; name: string } | null;
  previewAsReviewer: boolean;
  readOnly: boolean;
};

const KEY = 'pocus-view';
const initial: ViewState = { perspective: null, actingLearner: null, previewAsReviewer: false, readOnly: false };

function load(): ViewState {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return initial;
    const v = JSON.parse(raw);
    return {
      perspective: ['resident', 'faculty', 'admin'].includes(v.perspective) ? v.perspective : null,
      actingLearner: v.actingLearner && typeof v.actingLearner.id === 'string' ? { id: v.actingLearner.id, name: String(v.actingLearner.name ?? '') } : null,
      previewAsReviewer: v.previewAsReviewer === true,
      readOnly: false, // recomputed from the session
    };
  } catch {
    return initial;
  }
}

let state: ViewState = typeof window === 'undefined' ? initial : load();
const listeners = new Set<() => void>();

export function getView(): ViewState {
  return state;
}

export function setView(patch: Partial<ViewState>) {
  state = { ...state, ...patch };
  if (state.perspective !== 'resident') state = { ...state, actingLearner: null };
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ perspective: state.perspective, actingLearner: state.actingLearner, previewAsReviewer: state.previewAsReviewer }));
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

export function resetView() {
  state = initial;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useView(): ViewState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

export const useReadOnly = () => useView().readOnly;

/** Tooltip on disabled write buttons. */
export const READ_ONLY_TITLE = 'Read-only demonstration: changes are switched off.';

export const READ_ONLY_MESSAGE =
  'This is a read-only demonstration, so changes are switched off. Use “Feedback” to tell us what you would expect to happen here.';

/** Database functions that only read. Everything else is a write and is refused in read-only mode. */
export const READ_RPCS = new Set([
  'my_access', 'my_role', 'is_admin', 'is_staff', 'is_member', 'is_reviewer',
  'my_curriculum', 'my_evidence', 'my_requirements', 'my_exams', 'get_my_result',
  'itar_blocks', 'itar_block_overview', 'rotation_block_overview', 'rotation_status', 'itar_workspace', 'iter_template_for',
  'learner_report', 'exam_report', 'exam_version_issues', 'question_issues', 'staff_attempt_detail', 'evidence_due_for_deletion',
  'preview_exam_version', 'demo_fixture_learners', 'can_read_exam_media', 'can_read_evidence',
]);
/** The one write a reviewer may make. */
export const READ_ONLY_ALLOWED_WRITES = new Set(['submit_feedback']);
/** Learner read functions that accept p_as_learner. */
export const LEARNER_RPCS = new Set(['my_curriculum', 'my_evidence', 'my_requirements', 'my_exams', 'get_my_result']);

function blocked(): Response {
  return new Response(JSON.stringify({ code: 'READ_ONLY', message: READ_ONLY_MESSAGE, details: null, hint: null }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

type Classified = { kind: 'rpc'; fn: string } | { kind: 'table' } | { kind: 'storage-write' } | { kind: 'other' };

export function classify(url: string, method: string): Classified {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* relative */
  }
  const m = path.match(/\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/);
  if (m) return { kind: 'rpc', fn: m[1] };
  const read = method === 'GET' || method === 'HEAD';
  if (path.includes('/rest/v1/')) return read ? { kind: 'other' } : { kind: 'table' };
  if (path.includes('/storage/v1/')) {
    if (read || path.includes('/storage/v1/object/sign/')) return { kind: 'other' };
    return { kind: 'storage-write' };
  }
  return { kind: 'other' };
}

/** Decide what happens to one request, given the view. Exported for tests. */
export function plan(url: string, method: string, body: unknown, view: ViewState): { block: true } | { block: false; body: unknown; previewHeader: boolean } {
  const c = classify(url, method.toUpperCase());
  if (view.readOnly || view.previewAsReviewer || view.actingLearner) {
    if (c.kind === 'rpc' && !READ_RPCS.has(c.fn) && !READ_ONLY_ALLOWED_WRITES.has(c.fn)) return { block: true };
    if (c.kind === 'table' || c.kind === 'storage-write') return { block: true };
  }
  let out = body;
  if (c.kind === 'rpc' && view.actingLearner && LEARNER_RPCS.has(c.fn)) {
    let args: Record<string, unknown> = {};
    try {
      args = typeof body === 'string' && body ? JSON.parse(body) : {};
    } catch {
      /* keep empty */
    }
    out = JSON.stringify({ ...args, p_as_learner: view.actingLearner.id });
  }
  // Only the REST API (PostgREST) reads the preview header; it is not sent to Auth, Storage or Functions.
  const rest = c.kind === 'rpc' || /\/rest\/v1\//.test(url);
  return { block: false, body: out, previewHeader: view.previewAsReviewer && rest };
}

/** fetch for the Supabase client: applies the view to every API request. */
export const guardedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const p = plan(url, method, init?.body, state);
  if (p.block) return blocked();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (p.previewHeader) headers.set('x-portal-preview', 'reviewer');
  return fetch(input, { ...init, headers, body: p.body as BodyInit | null | undefined });
};
