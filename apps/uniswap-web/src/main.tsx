import { bootstrapSite } from './site/bootstrap.js';
import { readSiteConfig } from './site/config.js';
import './site/styles.css';

const config = readSiteConfig(import.meta.env);
const container = document.getElementById('root');
if (container === null) throw new Error('Missing app root');

if (config.mode === 'mock' && (location.pathname === '/app' || location.pathname === '/app/')) {
  const { bootstrapMockSite } = await import('./mock-bootstrap.js');
  await bootstrapMockSite(container, config);
} else {
  bootstrapSite({ container, config });
}
