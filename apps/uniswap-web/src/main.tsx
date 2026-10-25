import { bootstrapSite } from './site/bootstrap.js';
import { readSiteConfig } from './site/config.js';
import './site/styles.css';

const config = readSiteConfig(import.meta.env);
const container = document.getElementById('root');
if (container === null) throw new Error('Missing app root');

if (location.pathname === '/app' || location.pathname === '/app/') {
  if (config.mode === 'mock') {
    const { bootstrapMockSite } = await import('./mock-bootstrap.js');
    await bootstrapMockSite(container, config);
  } else {
    const [{ bootstrapLiveSite }, { createBrowserLiveController }] = await Promise.all([
      import('./live-bootstrap.js'),
      import('./live/browser-composition.js'),
    ]);
    await bootstrapLiveSite({ container, config, createController: createBrowserLiveController });
  }
} else {
  bootstrapSite({ container, config });
}
