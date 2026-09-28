import type { UiController } from './contracts/controller.js';
import { bootstrapSite } from './site/bootstrap.js';
import type { SiteConfig } from './site/config.js';

export interface LiveBootstrapOptions {
  readonly container: Element;
  readonly config: SiteConfig;
  readonly createController: (config: SiteConfig) => UiController | Promise<UiController>;
}

export async function bootstrapLiveSite({ container, config, createController }: LiveBootstrapOptions): Promise<{ dispose(): void }> {
  if (config.mode !== 'live') throw new Error('Live bootstrap requires live mode');
  let controller: UiController | undefined;
  try {
    controller = await createController(config);
  } catch {
    // A failed deployment or runtime check must not expose transaction actions.
    const root = bootstrapSite({ container, config });
    return { dispose: () => root.unmount() };
  }
  const root = bootstrapSite({ container, config, controller });
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', dispose);
    root.unmount();
    controller.dispose();
  };
  window.addEventListener('pagehide', dispose);
  return { dispose };
}
