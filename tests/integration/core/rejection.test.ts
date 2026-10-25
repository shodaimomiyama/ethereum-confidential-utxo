import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { bytesToHex } from "viem";
import type { Hex } from "viem";
import { M } from "@confidential-utxo/crypto";
import { authorizationTypedData, authorizeOperation, buildOperation, fixOperation } from "@confidential-utxo/core";
import type { PublicSubmission } from "@confidential-utxo/core";
import { createOperationSigner, decodePoolFailure, encodePoolSubmission, poolAbi } from "@confidential-utxo/ethereum";
import { withCoreAnvil } from "./anvil.js";
import { prepareRejectionFixture } from "./operations.js";

it("S-01-zero S-09-prior-sender S-09-other-chain S-09-other-pool S-09-unknown-version S-10-competing-operations S-10-successful-id-reuse S-10-copy-vs-competition S-13-one S-13-above-m S-13-negative-encoding S-17-deposit-reuse S-18-late-input-spend S-18-successful-competitor-kept S-04-spent-input", async () => {
  await withCoreAnvil(async fixture => {
    const prepared = await prepareRejectionFixture(fixture);
    expect(prepared.context.pool).toBe(fixture.manifest.pool.address);
    const pool = prepared.context.pool;
    const inputId = prepared.available[0]!.id;
    const snapshot = async () => ({
      accounting: await fixture.client.readContract({ address: pool, abi: poolAbi, functionName: "getAccounting" }),
      input: await fixture.client.readContract({ address: pool, abi: poolAbi, functionName: "getUtxo", args: [inputId] }),
    });
    const before = await snapshot();
    const first = await prepared.transfer(5n);
    const competitor = await prepared.transfer(6n);
    expect(first.operationId).not.toBe(competitor.operationId);
    const call = (submission: PublicSubmission) => {
      const encoded = encodePoolSubmission(submission);
      return fixture.client.call({ account: fixture.submitter.address, to: pool,
        data: encoded.data, value: encoded.value, gas: 15_000_000n });
    };
    const errorName = (error: unknown): string => {
      let current = error;
      for (let i = 0; i < 8 && current && typeof current === "object"; i++) {
        const data = Reflect.get(current, "data");
        if (typeof data === "string" && /^0x[0-9a-f]+$/i.test(data)) return decodePoolFailure(data as Hex).name;
        current = Reflect.get(current, "cause");
      }
      return "UNKNOWN";
    };
    const rejected = async (submission: PublicSubmission, expected: string) => {
      try { await call(submission); throw new Error("unexpected acceptance"); }
      catch (error) {
        if (error instanceof Error && error.message === "unexpected acceptance") throw error;
        expect(errorName(error)).toBe(expected);
      }
      expect(await snapshot()).toEqual(before);
    };
    await call(competitor.submission);
    const priorSender = structuredClone(competitor.submission);
    priorSender.signature = await prepared.bobAccount.signTypedData(
      authorizationTypedData(prepared.context, priorSender.request));
    await rejected(priorSender, "InvalidAuthorization");
    for (const [caseName, domain] of [
      ["other-chain", { ...prepared.context, chainId: prepared.context.chainId + 1n }],
      ["other-pool", { ...prepared.context, pool: fixture.bob.address }],
    ] as const) {
      const copied = structuredClone(competitor.submission);
      copied.signature = await prepared.aliceAccount.signTypedData(
        authorizationTypedData(domain, copied.request));
      await rejected(copied, "InvalidAuthorization");
      expect(caseName).toMatch(/other-/);
    }
    const unknownVersion = structuredClone(competitor.submission);
    const typed = authorizationTypedData(prepared.context, unknownVersion.request);
    unknownVersion.signature = await prepared.aliceAccount.signTypedData({
      ...typed, domain: { ...typed.domain, version: "2" },
    });
    await rejected(unknownVersion, "InvalidAuthorization");
    const invalidProof: PublicSubmission = { ...competitor.submission,
      balanceProof: { ...competitor.submission.balanceProof,
        s: competitor.submission.balanceProof.s + 1n } };
    await rejected(invalidProof, "InvalidBalanceProof");
    const invalidRange: PublicSubmission = { ...competitor.submission,
      rangeProofs: competitor.submission.rangeProofs.map((proof, index) => index === 0
        ? { ...proof, scalars: proof.scalars.map((value, at) => at === 0 ? value + 1n : value) } : proof) };
    await rejected(invalidRange, "InvalidRangeProof");
    for (const mutate of [
      (value: PublicSubmission) => { value.request.salt = bytesToHex(randomBytes(32)); },
      (value: PublicSubmission) => { value.request.outputs[0]!.packet = `0x${"00".repeat(112)}`; },
    ]) {
      const copied = structuredClone(competitor.submission);
      mutate(copied);
      await rejected(copied, "InvalidAuthorization");
    }
    for (const mutate of [
      (value: PublicSubmission) => { value.request.destination = fixture.bob.address; },
      (value: PublicSubmission) => { value.request.inputIds = []; },
      (value: PublicSubmission) => { value.request.d = 1n; },
      (value: PublicSubmission) => { value.request.w = 1n; },
      (value: PublicSubmission) => { value.request.owner = fixture.bob.address; },
    ]) {
      const copied = structuredClone(competitor.submission);
      mutate(copied);
      expect(() => encodePoolSubmission(copied)).toThrow();
      expect(await snapshot()).toEqual(before);
    }
    for (const amount of [0n, M + 1n, -1n]) {
      await expect(fixOperation({ kind: 0, owner: fixture.alice.address, amount,
        recipient: prepared.aliceRecipient }, prepared.context,
      { inputs: [], randomSalt: () => randomBytes(32) })).rejects.toThrow();
    }
    const firstReceipt = await fixture.client.waitForTransactionReceipt({ hash: await prepared.wallet.sendTransaction({
      to: pool, data: first.calldata.data, value: first.calldata.value, gas: 15_000_000n,
    }) });
    expect(firstReceipt.status).toBe("success");
    const accepted = await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "isOperationExecuted", args: [first.operationId] });
    expect(accepted).toBe(true);
    const acceptedState = await snapshot();
    expect(acceptedState.accounting).toEqual(before.accounting);
    expect(acceptedState.input[0]).toBe(2);
    const retry = async (data: Hex, value: bigint, id: Hex) => {
      const hash = await prepared.wallet.sendTransaction({ to: pool, data, value, gas: 15_000_000n });
      const receipt = await fixture.client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("reverted");
      expect(await fixture.client.readContract({ address: pool, abi: poolAbi,
        functionName: "isOperationExecuted", args: [id] })).toBe(id === first.operationId);
      expect(await snapshot()).toEqual(acceptedState);
      expect(receipt.logs).toHaveLength(0);
    };
    try { await call(competitor.submission); throw new Error("unexpected acceptance"); }
    catch (error) {
      if (error instanceof Error && error.message === "unexpected acceptance") throw error;
      expect(errorName(error)).toBe("InputAlreadySpent");
    }
    expect(await snapshot()).toEqual(acceptedState);
    try { await call(first.submission); throw new Error("unexpected acceptance"); }
    catch (error) {
      if (error instanceof Error && error.message === "unexpected acceptance") throw error;
      expect(errorName(error)).toBe("OperationAlreadyExecuted");
    }
    await retry(competitor.calldata.data, competitor.calldata.value, competitor.operationId);
    await retry(first.calldata.data, first.calldata.value, first.operationId);
    const output = await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getUtxo", args: [first.outputIds[0]!] });
    expect(output[0]).toBe(1);
    const deposit = await buildOperation({ kind: 0, owner: fixture.alice.address, amount: 1n,
      recipient: prepared.aliceRecipient }, prepared.context,
    { inputs: [], randomSalt: () => randomBytes(32) });
    const signedDeposit: PublicSubmission = { ...deposit, signature: await authorizeOperation(prepared.context,
      deposit.request, createOperationSigner(prepared.aliceAccount, fixture.alice.address)) };
    const depositCall = encodePoolSubmission(signedDeposit);
    const depositHash = await prepared.wallet.sendTransaction({ to: pool, ...depositCall, gas: 15_000_000n });
    expect((await fixture.client.waitForTransactionReceipt({ hash: depositHash })).status).toBe("success");
    const afterDeposit = await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getAccounting" });
    expect(afterDeposit[1]).toBe(acceptedState.accounting[1] + 1n);
    try { await call(signedDeposit); throw new Error("unexpected acceptance"); }
    catch (error) {
      if (error instanceof Error && error.message === "unexpected acceptance") throw error;
      expect(errorName(error)).toBe("OperationAlreadyExecuted");
    }
    const copiedDeposit = await prepared.wallet.sendTransaction({ to: pool, ...depositCall, gas: 15_000_000n });
    expect((await fixture.client.waitForTransactionReceipt({ hash: copiedDeposit })).status).toBe("reverted");
    expect(await fixture.client.readContract({ address: pool, abi: poolAbi,
      functionName: "getAccounting" })).toEqual(afterDeposit);
  });
}, 300_000);
