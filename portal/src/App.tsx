import { lazy, Suspense } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Layout, TopNav } from './components/Layout';
import { Spinner } from './components/ui';
import { isAdmin, isStaff, useAuth } from './lib/auth';
import { configured } from './lib/supabase';
import { Curriculum } from './pages/Curriculum';
import { ExamPlayer } from './pages/ExamPlayer';
import { ExamsList, LearnerHome } from './pages/LearnerHome';
import { Login } from './pages/Login';
import { Result } from './pages/Result';
// Staff-only screens are split into separate chunks so learners never download them.
const AdminHome = lazy(() => import('./pages/admin/AdminHome').then((m) => ({ default: m.AdminHome })));
const ExamsAdmin = lazy(() => import('./pages/admin/Exams').then((m) => ({ default: m.ExamsAdmin })));
const ExamEditor = lazy(() => import('./pages/admin/Exams').then((m) => ({ default: m.ExamEditor })));
const ImportExam = lazy(() => import('./pages/admin/Import').then((m) => ({ default: m.ImportExam })));
const MediaLibrary = lazy(() => import('./pages/admin/MediaLibrary').then((m) => ({ default: m.MediaLibrary })));
const People = lazy(() => import('./pages/admin/People').then((m) => ({ default: m.People })));
const QuestionBank = lazy(() => import('./pages/admin/Questions').then((m) => ({ default: m.QuestionBank })));
const QuestionEditor = lazy(() => import('./pages/admin/Questions').then((m) => ({ default: m.QuestionEditor })));
const EvaluationWorkspace = lazy(() => import('./pages/faculty/Evaluation').then((m) => ({ default: m.EvaluationWorkspace })));
const FacultyDashboard = lazy(() => import('./pages/faculty/Faculty').then((m) => ({ default: m.FacultyDashboard })));
const ExamResults = lazy(() => import('./pages/faculty/Faculty').then((m) => ({ default: m.ExamResults })));
const AttemptReview = lazy(() => import('./pages/faculty/Faculty').then((m) => ({ default: m.AttemptReview })));
const LearnerView = lazy(() => import('./pages/faculty/Faculty').then((m) => ({ default: m.LearnerView })));

function RequireAuth({ role }: { role?: 'staff' | 'admin' }) {
  const { loading, session, profile } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!session || !profile) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (role === 'staff' && !isStaff(profile)) return <Navigate to="/" replace />;
  if (role === 'admin' && !isAdmin(profile)) return <Navigate to="/" replace />;
  return role ? <Suspense fallback={<Spinner />}><Outlet /></Suspense> : <Outlet />;
}

function Home() {
  const { profile } = useAuth();
  return isStaff(profile) ? <Navigate to="/faculty" replace /> : <LearnerHome />;
}

function NotConfigured() {
  return (
    <>
      <TopNav />
      <div className="wrap narrow">
        <h1>Portal not configured</h1>
        <p>
          This build has no Supabase connection settings (<span className="mono">VITE_SUPABASE_URL</span>, <span className="mono">VITE_SUPABASE_ANON_KEY</span>).
          See <span className="mono">docs/exam-platform/DEPLOYMENT.md</span>. The public teaching cases are unaffected: <a href="/">return to the case series</a>.
        </p>
      </div>
    </>
  );
}

export function App() {
  if (!configured) return <NotConfigured />;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        {/* the exam player is full-screen, without the site nav */}
        <Route path="/exams/attempt/:attemptId" element={<ExamPlayer />} />
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="/curriculum" element={<Curriculum />} />
          <Route path="/exams" element={<ExamsList />} />
          <Route path="/exams/result/:attemptId" element={<Result />} />
          <Route element={<RequireAuth role="staff" />}>
            <Route path="/faculty" element={<FacultyDashboard />} />
            <Route path="/faculty/exams/:versionId" element={<ExamResults />} />
            <Route path="/faculty/attempts/:attemptId" element={<AttemptReview />} />
            <Route path="/faculty/learners/:learnerId" element={<LearnerView />} />
            <Route path="/faculty/evaluations/:evalId" element={<EvaluationWorkspace />} />
          </Route>
          <Route element={<RequireAuth role="admin" />}>
            <Route path="/admin" element={<AdminHome />} />
            <Route path="/admin/media" element={<MediaLibrary />} />
            <Route path="/admin/questions" element={<QuestionBank />} />
            <Route path="/admin/questions/:id" element={<QuestionEditor />} />
            <Route path="/admin/exams" element={<ExamsAdmin />} />
            <Route path="/admin/exams/:examId" element={<ExamEditor />} />
            <Route path="/admin/import" element={<ImportExam />} />
            <Route path="/admin/people" element={<People />} />
          </Route>
          <Route path="*" element={<div className="wrap"><h1>Not found</h1><p><a href="/app/">Portal home</a></p></div>} />
        </Route>
      </Route>
    </Routes>
  );
}
