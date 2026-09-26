import { describe, expect, it } from "vitest";
import applications from "../../../tests/vectors/cases/application-operation.json" with { type: "json" };
import hpkeCases from "../../../tests/vectors/cases/hpke.json" with { type: "json" };
import { hexBytes } from "../src/bytes.js";
import { G } from "../src/fixed-parameters.js";
import { mul, samePoint } from "../src/group.js";
import * as api from "../src/index.js";

describe("public crypto integration", () => {
  it("exports only the production capability set", () => {
    expect(Object.keys(api).sort()).toEqual([
      "CryptoFailure", "M", "P", "Q", "balanceWitness", "commit", "computeBalancePoint",
      "decryptReceipt", "encryptReceipt", "generateBalanceProof", "generateRangeProof", "randomBlinding", "validateCommitment",
    ].sort());
  });

  it("uses one application operation ID for receipt, range, and balance proofs", async () => {
    const app = applications.find((entry) => entry.id === "VEC-07-APPLICATION-DEPOSIT")!;
    const hpke = hpkeCases.find((entry) => entry.id === "VEC-07-RECEIPT-VALID")!;
    const output = app.input.outputs[0]!;
    const commitment = { x: BigInt(output.Cx), y: BigInt(output.Cy) };
    const opening = await api.decryptReceipt({
      recipientPrivateKey: hexBytes(hpke.input.recipientPrivateKey!),
      info: hexBytes(app.expected.info[0]!.hash),
      packet: hexBytes(output.packet), commitment,
    });
    expect(samePoint(api.commit(opening), commitment)).toBe(true);
    const operationId = hexBytes(app.expected.operationId);
    const range = api.generateRangeProof(opening, operationId, 0n);
    expect(range.coords.slice(0, 2)).toEqual([0n, 0n]);
    expect(range.coords).toHaveLength(10);
    expect(range.scalars).toHaveLength(5);
    expect(range.ls).toHaveLength(12);
    expect(range.rs).toHaveLength(12);
    const X = api.computeBalancePoint([], [commitment], 1n, 0n);
    expect(X).toEqual({ x: 0n, y: 0n });
    const proof = api.generateBalanceProof({
      X, x: 0n, chainId: BigInt(app.input.chainId),
      pool: hexBytes(app.input.pool), operationId,
    });
    expect(samePoint(mul(G, proof.s), { x: proof.Rx, y: proof.Ry })).toBe(true);
  });
});
