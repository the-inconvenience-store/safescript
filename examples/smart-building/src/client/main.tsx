import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';

import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('SafeScript Building Studio root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
