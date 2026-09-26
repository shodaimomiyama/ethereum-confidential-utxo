import React from 'react';
import { createRoot } from 'react-dom/client';
import { readSiteConfig } from './site/config.js';

const config = readSiteConfig(import.meta.env);
const element = document.getElementById('root');
if (element === null) throw new Error('Missing app root');

createRoot(element).render(
  <React.StrictMode>
    <main>
      <h1>Dim</h1>
      <p>Lightweight privacy for amounts on Ethereum.</p>
      <p>{config.mode === 'mock' ? 'Simulated demo' : 'Live connection'}</p>
    </main>
  </React.StrictMode>,
);
