import { createRoot } from 'react-dom/client';

import { App } from './app.js';

const root = document.getElementById('root');
if (root === null) throw new Error('Pair Web root element is missing');

createRoot(root).render(
  <App
    config={{
      apiBase: import.meta.env.VITE_PAIR_API_BASE,
      dshWebOrigin: import.meta.env.VITE_DSH_WEB_ORIGIN,
      shellOrigin: import.meta.env.VITE_PAIR_SHELL_ORIGIN,
    }}
  />,
);
