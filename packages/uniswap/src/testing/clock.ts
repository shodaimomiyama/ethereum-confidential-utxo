export interface ManualClock {
  now(): number;
  set(ms: number): void;
}

export function createManualClock(initialMs: number): ManualClock {
  let current = initialMs;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
  };
}
