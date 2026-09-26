import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { CoreFailure, selectInputs } from "../src/index.js";
import type { Context, OwnedUtxo } from "../src/index.js";

const M = 1n << 64n;
const owner = `0x${"11".repeat(20)}` as Address;
const otherOwner = `0x${"22".repeat(20)}` as Address;
const pool = `0x${"33".repeat(20)}` as Address;
const context: Context = {
  chainId: 1n, pool, deploymentBlock: 0n, verifier: owner,
  parametersHash: `0x${"44".repeat(32)}`, finalityMode: "finalized",
};
function id(value: bigint): Hex { return `0x${value.toString(16).padStart(64, "0")}`; }
function coin(value: bigint, amount: bigint, overrides: Partial<OwnedUtxo> = {}): OwnedUtxo {
  return {
    id: id(value), owner, opening: { amount, blinding: 1n }, commitment: { x: 0n, y: 0n },
    checkpoint: { number: 1n, hash: id(999n), mode: "finalized" },
    status: "available", chainId: context.chainId, pool, ...overrides,
  };
}
function failureCode(run: () => unknown) {
  try { run(); }
  catch (error) { expect(error).toBeInstanceOf(CoreFailure); return (error as CoreFailure).code; }
  throw new Error("expected CoreFailure");
}

describe("input selection", () => {
  it("selects one confirmed input and retains a representable remainder", () => {
    const chosen = selectInputs(context, [coin(1n, 10n)], { kind: 1, owner, amount: 3n });
    expect(chosen.map(c => c.id)).toEqual([id(1n)]);
    expect(chosen.reduce((sum, c) => sum + c.opening.amount, 0n) - 3n).toBe(7n);
  });

  it("prefers exact change and permits full withdrawal from two maximal inputs", () => {
    expect(selectInputs(context, [coin(2n, 10n), coin(1n, 11n)],
      { kind: 1, owner, amount: 10n }).map(c => c.id)).toEqual([id(2n)]);
    expect(selectInputs(context, [coin(2n, M), coin(1n, M)],
      { kind: 2, owner, amount: 2n * M }).map(c => c.id)).toEqual([id(1n), id(2n)]);
  });

  it("searches every pair and is independent of candidate order", () => {
    const coins = [coin(4n, M), coin(1n, M), coin(3n, 2n), coin(2n, 3n)];
    for (const candidates of [coins, [...coins].reverse(), [coins[2]!, coins[0]!, coins[3]!, coins[1]!]]) {
      expect(selectInputs(context, candidates, { kind: 2, owner, amount: M + 2n })
        .map(c => c.id)).toEqual([id(1n), id(3n)]);
    }
  });

  it("rejects an explicit pair whose change exceeds M", () => {
    const coins = [coin(1n, M), coin(2n, M), coin(3n, 5n)];
    expect(failureCode(() => selectInputs(context, coins, { kind: 1, owner, amount: 4n,
      explicitIds: [id(1n), id(2n)] }))).toBe("UNCONSTRUCTABLE");
    expect(selectInputs(context, coins, { kind: 1, owner, amount: 4n })
      .map(c => c.id)).toEqual([id(3n)]);
  });

  it("compares large bytes32 IDs numerically and resolves equal change by ID tuple", () => {
    const high = (1n << 255n) + 1n;
    const coins = [coin(high, 3n), coin(10n, 3n), coin(2n, 2n), coin(1n, 2n)];
    expect(selectInputs(context, coins, { kind: 1, owner, amount: 5n })
      .map(c => c.id)).toEqual([id(1n), id(10n)]);
  });

  it("uses explicit IDs exactly and returns them in numeric order", () => {
    const coins = [coin(1n, 2n), coin(2n, 8n), coin(3n, 10n)];
    expect(selectInputs(context, coins, { kind: 1, owner, amount: 10n,
      explicitIds: [id(2n), id(1n)] }).map(c => c.id)).toEqual([id(1n), id(2n)]);
    expect(failureCode(() => selectInputs(context, coins, { kind: 1, owner, amount: 10n,
      explicitIds: [id(1n)] }))).toBe("INSUFFICIENT");
    expect(failureCode(() => selectInputs(context, coins, { kind: 1, owner, amount: 10n,
      explicitIds: [id(100n)] }))).toBe("UNCONFIRMED");
  });

  it("filters unrelated and unconfirmed coins in automatic selection", () => {
    const coins = [coin(1n, 10n, { owner: otherOwner }), coin(2n, 10n, { chainId: 2n }),
      coin(3n, 10n, { status: "pending" }), coin(4n, 10n)];
    expect(selectInputs(context, coins, { kind: 1, owner, amount: 10n })
      .map(c => c.id)).toEqual([id(4n)]);
    expect(failureCode(() => selectInputs(context, coins, { kind: 1, owner, amount: 10n,
      explicitIds: [id(1n)] }))).toBe("INVALID_INPUT");
    expect(failureCode(() => selectInputs(context, coins, { kind: 1, owner, amount: 10n,
      explicitIds: [id(3n)] }))).toBe("UNCONFIRMED");
  });

  it("treats a mismatched checkpoint as unconfirmed", () => {
    const stale = coin(1n, 5n, { checkpoint: { number: 1n, hash: id(9n), mode: "local-simulated" } });
    expect(failureCode(() => selectInputs(context, [stale],
      { kind: 1, owner, amount: 5n }))).toBe("UNCONFIRMED");
  });

  it("distinguishes shortage, impossible two-input construction, and uncertain coverage", () => {
    expect(failureCode(() => selectInputs(context, [coin(1n, 2n)],
      { kind: 1, owner, amount: 3n }))).toBe("INSUFFICIENT");
    expect(failureCode(() => selectInputs(context, [coin(1n, 2n), coin(2n, 2n), coin(3n, 2n)],
      { kind: 1, owner, amount: 5n }))).toBe("UNCONSTRUCTABLE");
    expect(failureCode(() => selectInputs(context, [coin(1n, 2n), coin(2n, 2n, { status: "unknown" })],
      { kind: 1, owner, amount: 3n }))).toBe("UNCONFIRMED");
    expect(failureCode(() => selectInputs(context, [coin(1n, 2n), coin(2n, 2n, { status: "spent" })],
      { kind: 1, owner, amount: 3n }))).toBe("INSUFFICIENT");
  });

  it("rejects invalid operation bounds, duplicate IDs, and explicit input counts", () => {
    const coins = [coin(1n, M), coin(2n, M), coin(3n, M)];
    for (const [kind, amount] of [[1, 0n], [1, M + 1n], [2, 2n * M + 1n]] as const) {
      expect(failureCode(() => selectInputs(context, coins, { kind, owner, amount }))).toBe("INVALID_INPUT");
    }
    expect(failureCode(() => selectInputs(context, [coin(1n, 1n), coin(1n, 1n)],
      { kind: 1, owner, amount: 1n }))).toBe("INVALID_INPUT");
    expect(failureCode(() => selectInputs(context, [coin(1n, 1n), coin(1n, 1n, { id: id(1n).toUpperCase().replace("0X", "0x") as Hex })],
      { kind: 1, owner, amount: 1n }))).toBe("INVALID_INPUT");
    expect(failureCode(() => selectInputs(context, coins, { kind: 2, owner, amount: M,
      explicitIds: [id(1n), id(2n), id(3n)] }))).toBe("INVALID_INPUT");
  });
});
