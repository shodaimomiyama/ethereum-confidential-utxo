import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { PropsWithChildren } from 'react';
import type { UiController } from '../contracts/controller.js';
import type { ViewState } from '../contracts/state.js';

interface ControllerStore {
  readonly controller: UiController;
  getSnapshot(): ViewState;
  subscribe(listener: () => void): () => void;
}

function createStore(controller: UiController): ControllerStore {
  let current = controller.snapshot();
  const listeners = new Set<() => void>();
  let unsubscribeSource: (() => void) | undefined;
  return {
    controller,
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (unsubscribeSource === undefined) {
        current = controller.snapshot();
        unsubscribeSource = controller.subscribe((view) => {
          current = view;
          for (const subscriber of listeners) subscriber();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeSource?.();
          unsubscribeSource = undefined;
        }
      };
    },
  };
}

const ControllerContext = createContext<ControllerStore | null>(null);

export function ControllerProvider({ controller, children }: PropsWithChildren<{ controller: UiController }>) {
  const store = useMemo(() => createStore(controller), [controller]);
  return <ControllerContext.Provider value={store}>{children}</ControllerContext.Provider>;
}

function useStore(): ControllerStore {
  const store = useContext(ControllerContext);
  if (store === null) throw new Error('Missing ControllerProvider');
  return store;
}

export function useViewState(): ViewState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useController(): UiController {
  return useStore().controller;
}
