import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { configured } from './lib/supabase';
import './styles/portal.css';

const app = (
  <BrowserRouter basename="/app">
    <App />
  </BrowserRouter>
);

createRoot(document.getElementById('root')!).render(<StrictMode>{configured ? <AuthProvider>{app}</AuthProvider> : app}</StrictMode>);
