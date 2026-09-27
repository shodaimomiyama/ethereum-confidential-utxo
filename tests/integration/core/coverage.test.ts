import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

type Case = {
  caseId: string;
  scenarioId: string;
  requirements: string[];
  runner: "cli" | "api" | "foundry" | "sepolia";
  expectedOperation: "success" | "rejected" | "rolled-back" | "unconfirmed" | "unavailable";
  evidenceRef: string;
};

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as Case[];
const scenarios = Array.from({ length: 18 }, (_, index) => `S-${String(index + 1).padStart(2, "0")}`);

it("tracks every mandatory scenario with unique case IDs and evidence routes", () => {
  expect(new Set(cases.map(item => item.scenarioId))).toEqual(new Set(scenarios));
  expect(new Set(cases.map(item => item.caseId)).size).toBe(cases.length);
  for (const item of cases) {
    expect(item.caseId).toMatch(/^S-\d\d-[a-z0-9-]+$/);
    expect(item.caseId.startsWith(`${item.scenarioId}-`)).toBe(true);
    expect(item.requirements.length).toBeGreaterThan(0);
    expect(["cli", "api", "foundry", "sepolia"]).toContain(item.runner);
    expect(["success", "rejected", "rolled-back", "unconfirmed", "unavailable"])
      .toContain(item.expectedOperation);
    expect(item.evidenceRef).toMatch(/^(tests\/integration\/core\/|contracts\/test\/|packages\/)/);
    expect(item.evidenceRef).not.toContain("..");
  }
});
