import { useState } from 'react';
import type { Scenario, ScenarioHarness, ScenarioStep } from '../mock/scenario-catalog.js';
import { scenarios } from '../mock/scenario-catalog.js';
import type { MockExperience } from '../mock/experience.js';

export interface ScenarioSessionView {
  readonly scenario?: Scenario;
  readonly index: number;
  readonly nextStep?: ScenarioStep;
  readonly error?: string;
}

export interface ScenarioSession {
  select(id: string): boolean;
  next(): Promise<void>;
  reset(): void;
  snapshot(): ScenarioSessionView;
}

export async function nextScenarioStep(scenario: Scenario, index: number, harness: ScenarioHarness): Promise<number> {
  const step = scenario.steps[index];
  if (step === undefined) return index;
  if (step.kind === 'event') harness.driver.inject(step.event);
  else if (step.kind === 'clock') harness.clock.set(step.at);
  else {
    const result = await harness.controller.dispatch(step.action);
    if (result.kind !== step.result) throw new Error(`${scenario.id} step ${index + 1}: expected ${step.result}, got ${result.kind}`);
  }
  return index + 1;
}

export function createScenarioSession(experience: MockExperience): ScenarioSession {
  let scenario: Scenario | undefined;
  let index = 0;
  let error: string | undefined;
  function load(selected: Scenario): void {
    experience.reset();
    experience.store.control.reset(selected.seed);
    experience.clock.set(0);
    experience.mock.control.reset(selected.initialScenario);
    scenario = selected;
    index = 0;
    error = undefined;
  }
  return {
    select(id) {
      const found = scenarios.find((candidate) => candidate.id === id);
      if (found === undefined) { error = `Unknown scenario ID: ${id}`; return false; }
      load(found);
      return true;
    },
    async next() {
      if (scenario === undefined) { error = 'Choose a scenario first.'; return; }
      try {
        const previous = scenario.steps[index];
        index = await nextScenarioStep(scenario, index, {
          controller: experience.mock, driver: experience.mock.control, clock: experience.clock, store: experience.store,
        });
        if (previous?.kind === 'clock') experience.setClock(previous.at);
        error = undefined;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    },
    reset() { if (scenario) load(scenario); else experience.reset(); },
    snapshot() { return { scenario, index, nextStep: scenario?.steps[index], error }; },
  };
}

function stepDescription(step: ScenarioStep): string {
  if (step.kind === 'event') return `Event: ${step.event.type}`;
  if (step.kind === 'clock') return `Set mock clock: ${step.at} ms`;
  return `Action: ${step.action.type} → ${step.result}`;
}

export function ScenarioWorkbench({ experience, session: provided }: {
  readonly experience: MockExperience; readonly session?: ScenarioSession;
}) {
  const [session] = useState(() => provided ?? createScenarioSession(experience));
  const [selected, setSelected] = useState(scenarios[0]?.id ?? '');
  const [clockText, setClockText] = useState('0');
  const [, refresh] = useState(0);
  const update = () => refresh((value) => value + 1);
  const view = session.snapshot();
  return <section className="workbench surface" aria-label="Mock scenario workbench">
    <h2>Scenario workbench</h2>
    <p className="muted">Local simulation only. No wallet signatures or network transactions are sent.</p>
    <label htmlFor="scenario-select">Scenario</label>
    <select id="scenario-select" value={selected} onChange={(event) => setSelected(event.target.value)}>
      {scenarios.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.id}</option>)}
    </select>
    <div className="workbench-actions">
      <button type="button" onClick={() => { session.select(selected); update(); }}>Load scenario</button>
      <button type="button" disabled={!view.nextStep} onClick={() => { void session.next().then(update); }}>Next step</button>
      <button type="button" onClick={() => { session.reset(); update(); }}>Reset scenario</button>
      <button type="button" onClick={() => { experience.advance(); update(); }}>Advance simulation</button>
    </div>
    <label htmlFor="mock-clock">Mock clock (milliseconds)</label>
    <div className="clock-control"><input id="mock-clock" type="text" inputMode="numeric" value={clockText} onChange={(event) => setClockText(event.target.value)} />
      <button type="button" onClick={() => { const value = Number(clockText); if (clockText.trim() && Number.isFinite(value)) { experience.setClock(value); update(); } }}>Set clock</button></div>
    {view.error && <p role="alert">{view.error}</p>}
    {view.scenario && <><p>Specification: {view.scenario.specIds.join(', ')}</p>
      <p>Step {view.index} of {view.scenario.steps.length}. {view.nextStep ? stepDescription(view.nextStep) : 'Scenario complete.'}</p>
      <ol>{view.scenario.steps.map((step, position) => <li key={position} aria-current={position === view.index ? 'step' : undefined}>{stepDescription(step)}</li>)}</ol></>}
    <p>Current mock clock: {experience.clock.now()} ms</p>
    <h3>Effect journal</h3>
    <ol>{experience.mock.control.journal().map((entry, position) => <li key={position}>{entry.kind}{entry.operationId ? ` ${entry.operationId}` : ''}</li>)}</ol>
  </section>;
}
