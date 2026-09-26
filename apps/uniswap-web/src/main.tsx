import React from 'react';
import { createRoot } from 'react-dom/client';
import { readSiteConfig } from './site/config.js';
import { Introduction } from './site/Introduction.js';
import { AppPage } from './site/AppPage.js';
import './site/styles.css';

const config = readSiteConfig(import.meta.env);
const element = document.getElementById('root');
if (element === null) throw new Error('Missing app root');

const root = createRoot(element);
if (location.pathname.startsWith('/app')) {
  if (config.mode !== 'mock') throw new Error('Live controller must be injected by the live bootstrap');
  const { createMockExperience } = await import('./mock/experience.js');
  const controller = createMockExperience({ scope: {
    deploymentId: config.deploymentId as never,
    owner: `0x${'11'.repeat(20)}` as never,
  } });
  const saved = localStorage.getItem('dim-mock-session-v1');
  if (saved !== null) {
    try { await controller.restore(saved); } catch { localStorage.removeItem('dim-mock-session-v1'); }
  }
  controller.subscribe(() => localStorage.setItem('dim-mock-session-v1', controller.save()));
  root.render(<React.StrictMode><AppPage controller={controller} config={config} /></React.StrictMode>);
} else {
  root.render(<React.StrictMode><Introduction config={config} /></React.StrictMode>);
}
