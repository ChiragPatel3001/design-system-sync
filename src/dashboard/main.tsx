import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens/index.css';
import './dashboard.css';
import { Dashboard } from './Dashboard.tsx';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
