import { M } from "@confidential-utxo/crypto";
import type { Address, Hex } from "viem";
import { CoreFailure } from "./errors.js";
import type { Context, OwnedUtxo } from "./types.js";

type SelectionContext = Pick<Context, "chainId" | "pool" | "deploymentBlock" | "finalityMode">;
type SelectionOptions = { kind: 1 | 2; owner: Address; amount: bigint; explicitIds?: Hex[] };

function invalid(): never { throw new CoreFailure("INVALID_INPUT", "selection"); }
function failure(code: "INSUFFICIENT" | "UNCONSTRUCTABLE" | "UNCONFIRMED"): never {
  throw new CoreFailure(code, "selection");
}
function sameAddress(a: Address, b: Address): boolean { return a.toLowerCase() === b.toLowerCase(); }
function numericId(id: Hex): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) invalid();
  return BigInt(id);
}
function compareId(a: OwnedUtxo, b: OwnedUtxo): number {
  const left = numericId(a.id);
  const right = numericId(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
}
function confirmed(coin: OwnedUtxo, context: SelectionContext): boolean {
  return coin.status === "available" && coin.checkpoint.mode === context.finalityMode &&
    coin.checkpoint.number >= context.deploymentBlock;
}
function matching(coin: OwnedUtxo, context: SelectionContext, owner: Address): boolean {
  return coin.chainId === context.chainId && sameAddress(coin.pool, context.pool) &&
    sameAddress(coin.owner, owner);
}
function sum(coins: OwnedUtxo[]): bigint {
  return coins.reduce((total, coin) => total + coin.opening.amount, 0n);
}
function feasible(coins: OwnedUtxo[], amount: bigint): boolean {
  const change = sum(coins) - amount;
  return change >= 0n && change <= M;
}
function bestPair(coins: OwnedUtxo[], amount: bigint): OwnedUtxo[] | undefined {
  let best: OwnedUtxo[] | undefined;
  let bestChange: bigint | undefined;
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      const pair = [coins[i]!, coins[j]!];
      if (!feasible(pair, amount)) continue;
      const change = sum(pair) - amount;
      if (bestChange === undefined || change < bestChange) {
        best = pair;
        bestChange = change;
      }
    }
  }
  return best;
}

/** Selects at most two confirmed inputs, preferring input count, change, then numeric ID tuple. */
export function selectInputs(
  context: SelectionContext, candidates: OwnedUtxo[],
  { kind, owner, amount, explicitIds }: SelectionOptions,
): OwnedUtxo[] {
  if ((kind !== 1 && kind !== 2) || typeof amount !== "bigint" ||
      amount < 1n || amount > (kind === 1 ? M : 2n * M)) invalid();
  if (!Array.isArray(candidates)) invalid();
  const ordered = [...candidates].sort(compareId);
  for (let i = 0; i < ordered.length; i++) {
    const coin = ordered[i]!;
    if (i > 0 && compareId(ordered[i - 1]!, coin) === 0) invalid();
    if (typeof coin.opening?.amount !== "bigint" || coin.opening.amount < 1n || coin.opening.amount > M) invalid();
  }

  if (explicitIds !== undefined) {
    if (!Array.isArray(explicitIds) || explicitIds.length < 1 || explicitIds.length > 2) invalid();
    const ids = explicitIds.map(numericId);
    if (new Set(ids).size !== ids.length) invalid();
    const chosen = ids.map(id => ordered.find(coin => numericId(coin.id) === id));
    if (chosen.some(coin => coin === undefined)) failure("UNCONFIRMED");
    const selected = (chosen as OwnedUtxo[]).sort(compareId);
    if (selected.some(coin => !matching(coin, context, owner))) invalid();
    if (selected.some(coin => !confirmed(coin, context))) failure("UNCONFIRMED");
    if (!feasible(selected, amount)) failure(sum(selected) < amount ? "INSUFFICIENT" : "UNCONSTRUCTABLE");
    return selected;
  }

  const eligible = ordered.filter(coin => matching(coin, context, owner));
  const available = eligible.filter(coin => confirmed(coin, context));
  const singles = available.filter(coin => feasible([coin], amount));
  if (singles.length > 0) {
    singles.sort((a, b) => a.opening.amount < b.opening.amount ? -1 :
      a.opening.amount > b.opening.amount ? 1 : compareId(a, b));
    return [singles[0]!];
  }
  const pair = bestPair(available, amount);
  if (pair) return pair;

  const uncertain = eligible.filter(coin => coin.status === "pending" || coin.status === "unknown" ||
    (coin.status === "available" && !confirmed(coin, context)));
  const possiblyAvailable = [...available, ...uncertain].sort(compareId);
  if (uncertain.length > 0 &&
      (possiblyAvailable.some(coin => feasible([coin], amount)) || bestPair(possiblyAvailable, amount))) {
    failure("UNCONFIRMED");
  }
  failure(sum(possiblyAvailable) < amount ? "INSUFFICIENT" : "UNCONSTRUCTABLE");
}
