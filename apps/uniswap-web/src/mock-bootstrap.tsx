import { createMockExperience } from './mock/experience.js';
import { bootstrapSite } from './site/bootstrap.js';
import type { SiteConfig } from './site/config.js';
import { ScenarioWorkbench } from './site/ScenarioWorkbench.js';

const sessionKey = 'dim-mock-session-v1';

export async function bootstrapMockSite(container: Element, config: SiteConfig): Promise<void> {
  const controller = createMockExperience({ scope: {
    deploymentId: config.deploymentId as never,
    owner: `0x${'11'.repeat(20)}` as never,
  } });
  const saved = localStorage.getItem(sessionKey);
  if (saved !== null) {
    try { await controller.restore(saved); } catch { localStorage.removeItem(sessionKey); }
  }
  controller.subscribe(() => localStorage.setItem(sessionKey, controller.save()));
  bootstrapSite({ container, config, controller, workbench: <ScenarioWorkbench experience={controller} /> });
}
