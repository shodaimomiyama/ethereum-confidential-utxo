import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { UiController } from '../contracts/controller.js';
import { AppPage } from './AppPage.js';
import type { SiteConfig } from './config.js';
import { Introduction } from './Introduction.js';
import { MockTransactionPage } from './mock-transaction.js';

export interface SiteBootstrapOptions {
  readonly container: Element;
  readonly config: SiteConfig;
  readonly controller?: UiController;
  readonly workbench?: ReactNode;
  readonly pathname?: string;
}

export function bootstrapSite({ container, config, controller, workbench, pathname = location.pathname }: SiteBootstrapOptions): Root {
  const root = createRoot(container);
  const mockDetail = pathname.match(/^\/app\/mock-transaction\/(.+)$/);
  if (config.mode === 'mock' && mockDetail) {
    let hash = '';
    try { hash = decodeURIComponent(mockDetail[1] ?? ''); } catch { hash = ''; }
    root.render(<MockTransactionPage hash={hash} />);
  } else if (pathname === '/app' || pathname === '/app/') {
    root.render(controller
      ? <AppPage controller={controller} config={config} workbench={config.mode === 'mock' ? workbench : undefined} />
      : <main className="transaction-page surface"><h1>Dim app is not configured</h1><p>A live controller must be provided by the integration bootstrap.</p></main>);
  } else {
    root.render(<Introduction config={config} />);
  }
  return root;
}
