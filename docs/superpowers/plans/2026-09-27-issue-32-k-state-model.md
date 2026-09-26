# Issue #32 K State Model and P/Q Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Issue #32's MODEL-01–MODEL-08 obligations in K for the PoC state model and abstract authorization paths P/Q, with reproducible evidence and explicit handoff to #33/#34.

**Architecture:** Define one K state machine for accepted history, authorization context, ETH accounting, and call frames. Keep P and Q as separate request/authorization entry paths that normalize to the common transition. Prove symbolic one-step preservation and a finite-history induction bridge; concrete `krun` scenarios expose nonvacuity and boundary behavior.

**Tech Stack:** K Framework and backend/solver from #4's pinned lock; `kompile`, `krun`, `kprove`; Python 3 standard library for the local proof runner and manifest; macOS ARM64.

**Spec:** [Issue #32](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/32), and repository `docs/{requirements,specification,design,architecture}.md` at `5d9e378ed9d1e970723a198b244e74aa868d6c74`. The Issue's agreed scope overrides the Architecture's Ubuntu verification target for this Issue.

## Global Constraints

- `M = 2^64 wei`, `N = 2`, `W = 2^65 wei`. Each asset UTXO has `1 ≤ value ≤ M`; sums use mathematical integers. Actual bounded representation and overflow rejection remain #33/#34 connection obligations.
- D-03 rejects reentry into every asset operation. Simple ETH receipt, including return from a withdrawal recipient or withdrawal to Pool itself, increases `B` and `E`, never `L`.
- `A = L`, `B = L + E`, `E ≥ 0` hold at accepted transaction boundaries. Initial `U=S=H=∅`, `A=L=0`, `E=B≥0`.
- The same accepted logical operation stays the same across P/Q, relayers, envelope nonce, proof or signature re-generation. A newly authorized equal-value deposit can differ by the D-04 identifier.
- Prove over symbolic valid states and arbitrary finite accepted histories, plus reachable successful operations. Model-level proof must not assume conservation, current-state checks, path equivalence, or authorization-field binding.
- Use #4's locked toolchain and build entry once available. Mandatory verification is a fresh clone on macOS ARM64; Ubuntu verification and CI creation are outside this Issue.
- Initial budget: 60 minutes per claim, 16 GiB RAM, one worker, 24 hours for suite. Record any overrun as unresolved; do not report success.
- A `.k` model or test is an implementation artifact. The repository's `.agents/rules/documentation.md` applies to any new Markdown files; this plan does not pre-approve additional Markdown.
- Do not claim bytecode correctness, cryptographic soundness, or U-04 from the abstract proof. #33 and #34 discharge implementation bridges.

## File map and interfaces

| File | Responsibility |
| --- | --- |
| `formal/model/model.k` | Main module `UTXO-MODEL`; configuration, `State`, `Utxo`, `Operation`, `Effect`, `Outcome` constructors; common state predicates |
| `formal/model/auth.k` | Module `UTXO-AUTH`; authorization certificate and context validation; logical operation identity |
| `formal/model/operations.k` | Module `UTXO-OPERATIONS`; common deposit/transfer/withdraw/receive transitions and rollback |
| `formal/model/paths.k` | Module `UTXO-PATHS`; separate `PRequest` and `QRequest`, decode and authorization steps, projection `assetView` |
| `formal/model/claims/model-01.k` … `model-08.k` | Stable obligation groups; child labels like `MODEL-01-preserve-deposit` |
| `formal/model/scenarios.k` | Concrete executable programs and expected outcomes, identified by S number |
| `formal/model/obligations.json` | Canonical claim IDs, requirement/section links, files, assumptions, later bridge obligations |
| `formal/model/run.py` | `compile`, `scenario`, `prove --group`, `prove --all`, `check-results` CLI; fail-closed result parser |
| `formal/model/test_run.py` | Python tests of manifest completeness, duplicate IDs, missing/skip/timeout/partial result handling |
| `formal/model/evidence/` | Machine-readable run manifest, per-claim result and raw log; exact generated content is populated only after actual verification |

`UTXO-AUTH` imports `UTXO-MODEL`; `UTXO-OPERATIONS` imports `UTXO-AUTH`; `UTXO-PATHS` imports `UTXO-OPERATIONS`. Early tasks compile the current top module until all four exist; before Task 3, `UTXO-OPERATIONS` imports `UTXO-MODEL` directly and switches to `UTXO-AUTH` when that module is added. The main model's state is a semantic record `State(U,S,H,B,A,E,Frames,Events,Context)`; `L(State)` is derived from unspent UTXOs. `apply(State,ValidatedOperation,Context) -> Outcome` returns `Accepted(State,Effect)` or `Rejected(State,Reason)`. `execP(State,PRequest,Context)` and `execQ(State,QRequest,Context)` are separate interfaces returning the same `Outcome` type. `ValidatedOperation` records a checked operation and authorization result; only the P/Q entry rules may construct it from an untrusted request. The kernel proves asset effects conditional on this checked input, while MODEL-02/07 prove the checking step. `assetView(Outcome)` drops envelope gas/nonce and retains U/S/H, owners, values, B/A/E, authorized deposits/withdrawals and success events. Exact K sort/constructor syntax should follow the pinned K release; the names and semantics above are stable interfaces.

Each proof file imports the latest module needed by its claim and is listed in `obligations.json`. The runner invokes the pinned toolchain, e.g. `kompile formal/model/paths.k --main-module UTXO-PATHS --syntax-module UTXO-MODEL --backend haskell -o formal/model/.build`, then `kprove formal/model/claims/model-01.k --definition formal/model/.build --spec-module UTXO-MODEL-01`. Before `paths.k` exists, compile the current top module and prove only its claims. #4's wrapper may replace these literal commands only while preserving the locked backend and recording the actual command. See the [K user manual](https://github.com/runtimeverification/k/blob/master/docs/user_manual.md) for the tool roles.

## Review Focus

These five failures are easy to miss in a proof that only covers happy paths. Their tests appear in Tasks 2, 3, 4, 5 and 7 respectively.

1. An operation with an absent, duplicate, spent or differently owned input must reject without changing unrelated UTXOs.
2. An identical deposit submitted through the other path with new ETH must not mint again; a fresh authorized deposit with equal value must work.
3. Q's previously valid certificate becomes unusable after input consumption or expiry; submitter-supplied success is never trusted.
4. A withdrawal recipient catches failed reentry and sends ETH back: the outer withdrawal can succeed, with the return classified as unaccounted ETH.
5. A prover process exits zero yet a required claim is missing, skipped, timed out, stuck or unresolved: suite status must fail.

---

### Task 1: State and executable accounting kernel

**Files:** Create `formal/model/model.k`, `formal/model/operations.k`, `formal/model/scenarios.k`. Use `formal/model/claims/model-01.k`.

**Interfaces:** Produce `State`, `Utxo`, `Operation`, `ValidatedOperation`, `Outcome`, `L(State)`, `wellFormed(State)`, `apply(State,ValidatedOperation,Context)`. Preserve all later file interfaces from the map.

- [ ] **Step 1: Write failing scenarios.** Initial `B=7,E=7,L=A=0`; a deposit kernel call with an explicitly validated operation of 10 makes `B=17,E=7,A=L=10`; simple receipt of 4 changes only `B,E` to `21,11`. A deposit with received ETH different from `d` rejects without mint.
- [ ] **Step 2: Run `kompile` and `krun` on these scenarios.** Expect no successful model run before constructors and rules exist; record the failure.
- [ ] **Step 3: Implement state and accounting.** Keep consumed records in `U`; make `S⊆ids(U)`. Generate only fresh IDs, append logical success to `H`, and keep `A` equal to derived `L` on accepted completion.
- [ ] **Step 4: Add symbolic claims.** Prove symbolic backing balance preservation for deposit and simple receive, plus derived liability equality for initial deposit and receive. The general `A = Σ unspent UTXO values` induction needs a map-update lemma; complete it in Task 6 rather than assuming it in the kernel. Register transfer/withdrawal preservation as pending MODEL-01 subclaims for Task 2.
- [ ] **Step 5: Run Task 1 scenarios and `kprove .../model-01.k`.** Expect all current scenarios and implemented MODEL-01 subclaims to finish; do not count the group complete while registered transfer/withdrawal subclaims are pending.
- [ ] **Step 6: Commit** `feat(formal): add executable asset state and conservation claims`.

### Task 2: Amount shape, ownership and one-time consumption

**Files:** Modify `formal/model/model.k`, `formal/model/operations.k`, `formal/model/scenarios.k`; create `formal/model/claims/model-03.k` and `formal/model/claims/model-06.k`.

**Interfaces:** Consume `apply` and `wellFormed`; produce `Deposit`, `Transfer`, `Withdraw` transitions over `ValidatedOperation` and `validShape(Operation,State)`. Their callers remain internal test constructors until Task 4 proves P/Q validation.

- [ ] **Step 1: Write failing boundary scenarios.** `1` and `M` valid; `0`, `M+1`, negative representation invalid. Input count 2 valid, 3 invalid. `M+M→M+M` valid when outputs each ≤M. Full withdrawal `W` valid; zero change omitted.
- [ ] **Step 2: Run scenario command.** Expect failures where shape/ownership checks are absent.
- [ ] **Step 3: Implement `validShape` and transition checks.** Transfer/withdrawal consume 1–2 unspent inputs of one owner; transfer emits one recipient output and optional positive owner change; withdrawal emits optional positive owner remainder and sends to one authorized destination. Self-transfer, merge, split and recreate reuse transfer rules.
- [ ] **Step 4: Write negative scenarios.** Absent, duplicate, spent, mixed-owner inputs, new-ID collision, overlarge change and unrelated UTXO mutation must reject atomically.
- [ ] **Step 5: Add transfer/withdrawal preservation claims to MODEL-01, symbolic MODEL-03 claims and symbolic success claims in MODEL-06.** Prove one-step duplicate-input, spent-input and output-collision rejection symbolically. Prove existing-record immutability and spent-set growth for one- and two-input symbolic witnesses, with concrete scenarios for unaffected IDs and self-operations. The arbitrary-map frame lemma and arbitrary accepted-history monotonicity are completed in Task 6; keep MODEL-03 incomplete until then. Prove precondition-satisfying deposit, full/partial transfer, merge, self-operation, full/partial withdrawal reach `Accepted`; use symbolic values plus satisfiable witnesses.
- [ ] **Step 6: Run scenarios and both proof groups; commit** `feat(formal): prove shape, unique consumption and normal operations`.

### Task 3: Logical identity and authorization

**Files:** Create `formal/model/auth.k`, `formal/model/claims/model-02.k`, `formal/model/claims/model-04.k`; modify `formal/model/scenarios.k`.

**Interfaces:** Produce `logicalId(Operation,Domain,Randomness)`, `AuthCert(Issuer,Rule,Owner,LogicalId,Domain,Version,Conditions)`, `validCert(Cert,Operation,Context)` and `validate(Operation,Cert,Context) -> ValidatedOperation | Rejected`. MODEL-02 establishes that untrusted requests cannot bypass this constructor. `validCert` checks issuer trust under the selected rule and every bound field at the current execution context.

- [ ] **Step 1: Write failing scenarios.** Wrong owner, output, amount, recipient packet binding, withdrawal destination, chain, Pool, version, operation ID or issuer rejects; changing submitter, envelope nonce, signature/proof bytes or P/Q does not make a logical operation new.
- [ ] **Step 2: Execute scenarios and observe failures.**
- [ ] **Step 3: Implement logical identity and certificate validation.** Distinguish abstract trust in a verifier from the actual field comparisons. Do not define `validCert` as a bare submitted Boolean.
- [ ] **Step 4: Write deposit replay scenario.** After one validated deposit 10, a second use of the same logical ID with an additional 10 ETH rejects without mint; another deposit 10 with new randomness and fresh authorization accepts. The cross-path variant is added in Task 4.
- [ ] **Step 5: Add MODEL-02 and MODEL-04 symbolic claims.** Field changes cannot be accepted under the old certificate; H and input consumption independently prevent reuse. Show two independent deposits in either order here; the general disjoint-operation commutation lemma over arbitrary maps is completed with accepted-history reasoning in Task 6. Keep MODEL-04 incomplete until then.
- [ ] **Step 6: Prove and commit** `feat(formal): bind authorization and reject logical replay`.

### Task 4: Abstract paths P/Q and current-state checks

**Files:** Create `formal/model/paths.k`, `formal/model/claims/model-07.k`; modify `formal/model/scenarios.k`.

**Interfaces:** Produce `decodeP(PRequest)`, `decodeQ(QRequest)`, `execP(State,PRequest,Context)`, `execQ(State,QRequest,Context)`, `assetView(Outcome)`, `sameLogicalEffect(Outcome,Outcome,IdMap)`.

- [ ] **Step 1: Write paired failing scenarios.** Same authorized 10-deposit, 10→3+7 transfer and full/partial withdrawal in P and Q produce equivalent asset views. Reusing the P deposit through Q with fresh ETH rejects without mint, and vice versa. An expired Q certificate, certificate for an old state after another operation spends the input, and a caller-provided success flag reject.
- [ ] **Step 2: Run paired scenarios; expect P/Q not yet implemented.**
- [ ] **Step 3: Implement separate request decode and authorization stages.** P verifies within execution; Q checks the trusted prior certificate and its current applicability. Both recheck H and current U/S before `apply`.
- [ ] **Step 4: Add symbolic MODEL-07 claims.** Under same current state, logical operation and external conditions, prove `assetView(execP) ≅ assetView(execQ) ≅ assetView(apply)`. Prove malformed/expired/replayed/colliding requests reject with unchanged asset state. A renaming map must be injective on generated IDs and logical IDs and preserve H.
- [ ] **Step 5: Prove, run scenarios and commit** `feat(formal): prove P and Q asset effects`.

### Task 5: Call frames, reentry and atomic rollback

**Files:** Modify `formal/model/operations.k`, `formal/model/model.k`, `formal/model/scenarios.k`; create `formal/model/claims/model-05.k`.

**Interfaces:** Produce `Frame(Snapshot,PendingEffects,PendingEvents)`; model recipient outcomes `ReceiveOK`, `CatchReentry`, `PropagateReentry`, `RejectReceive`, `ReturnETH(e)`, `OuterRevert`. `commitFrame` or `rollbackFrame` returns final `Outcome`.

- [ ] **Step 1: Write failing scenarios.** Caught asset reentry changes no inner asset state yet outer withdrawal can succeed. Propagated reentry or failed ETH receive reverts withdrawal and success event. Return `e` yields `ΔB=-w+e, ΔA=ΔL=-w, ΔE=e`; reverting the frame removes return. Withdrawal to Pool itself follows simple-receive classification.
- [ ] **Step 2: Run scenarios and observe missing behavior.**
- [ ] **Step 3: Implement frame-local pending effects and rollback.** Snapshot at the operation/frame boundary. Asset-entry lock is active before any external verifier or recipient call. Independent prior success is preserved when a later caught call fails; outer-frame revert rolls back its successful descendants. A failed operation remains retryable if its preconditions still hold.
- [ ] **Step 4: Add MODEL-05 symbolic claims.** No partial U/S/H/A/B/E/events on failed operation; receiver catch/propagation and return behavior; inner accepted effect is absent under outer rollback.
- [ ] **Step 5: Prove, run scenarios and commit** `feat(formal): prove external-call atomicity and reentry rejection`.

### Task 6: Envelope accounting and finite-history invariant

**Files:** Modify `formal/model/model.k`, `formal/model/operations.k`, `formal/model/paths.k`; create `formal/model/claims/model-08.k`; extend `model-01.k` and `model-03.k`.

**Interfaces:** Produce `Envelope(Sender,GasPayer,Nonce,GasSpent,GasRefund)` outside `assetView`; `acceptedHistory(InitialState,OperationList,FinalState)` for induction.

- [ ] **Step 1: Write failing scenarios.** An authorized operation submitted by someone other than owner still works. Gas charged/refunded to envelope payer does not change U/S/H/A/L/E/B. Failed asset operation may consume outside gas while preserving the asset snapshot. ETH actually arriving at Pool is classified as authorized deposit or simple receive.
- [ ] **Step 2: Run scenarios; expect a failing envelope separation check.**
- [ ] **Step 3: Implement separation and finite-history relation.** Reuse the one-step invariant; do not infer arbitrary-history safety only from a finite trace example.
- [ ] **Step 4: Prove MODEL-08 and induction base/step for MODEL-01/03/04/05.** Prove the map-update lemma connecting `A` to the sum of unspent UTXO values; do not assume it. State the initial-state and per-accepted-transition hypotheses explicitly and derive invariant for every finite accepted history.
- [ ] **Step 5: Prove, run scenarios and commit** `feat(formal): prove envelope separation and finite-history safety`.

### Task 7: Reproducible proof runner and closed evidence

**Files:** Create `formal/model/run.py`, `formal/model/test_run.py`, `formal/model/obligations.json`; produce `formal/model/evidence/` from actual runs.

**Interfaces:** `python3 formal/model/run.py compile`, `scenario`, `prove --group MODEL-01`, `prove --all`, `check-results`. Each result record identifies claim ID, group, source/hash, assumptions, tool lock/config, exact command, status, duration, peak resources, raw log and unproved scope.

- [ ] **Step 1: Write failing Python tests.** Reject duplicate or absent required MODEL-01…08 group; a zero-exit prover log missing a claim; skipped, admitted, stuck, timeout, unresolved or partly complete claim; missing raw log or source hash; mismatched lock/digest.
- [ ] **Step 2: Run `python3 -m unittest formal/model/test_run.py`; expect failures.**
- [ ] **Step 3: Implement runner and strict evidence checks.** Use #4's locked command path; record actual executable versions/digests, host/VM details and hashes. List expected claims before launching prover. No `latest`, fallback backend, or silent omission.
- [ ] **Step 4: Run unit tests, `compile`, `scenario`, individual `prove --group`, `prove --all`, `check-results` on macOS ARM64.** Expect every claim complete within 60 minutes/16 GiB and suite within 24 hours. On failure, preserve raw status and treat as unfinished; refine claims or design before claiming acceptance.
- [ ] **Step 5: Commit** `build(formal): make model proofs reproducible and fail closed`.

### Task 8: Traceability and #33/#34 handoff

**Files:** Complete `formal/model/obligations.json`; generate `formal/model/evidence/manifest.json` and `results.json` via `run.py`. Edit existing documentation only if it needs a factual cross-reference; seek the repository-required authorization before any new Markdown file.

**Interfaces:** `obligations.json` maps every claim to Issue group, FV/SEC/FR ID, exact specification/design section, source path, assumptions, result and later bridge. Consumers #33/#34 pin this model's source hash.

- [ ] **Step 1: Add a failing runner test.** Missing requirement link, missing assumption, missing #33/#34 bridge or hash, and falsely populated bytecode hash must fail validation.
- [ ] **Step 2: Run unit test; expect failure.**
- [ ] **Step 3: Complete mappings.** #33 bridge: storage/status/accountedLiability, actual authorization parsing and field binding, operation/output IDs, verifier input/result, ETH transfer, logs, reentry and revert. #34 bridge: fixed verifier implementation and relation imply model's positive bounds and integer conservation; document required Pool public-input binding.
- [ ] **Step 4: Run `python3 -m unittest formal/model/test_run.py` and `python3 formal/model/run.py check-results`; inspect all MODEL-01…08 records, assumptions and unproved scopes.** Bytecode hash is explicitly out of scope for #32.
- [ ] **Step 5: Commit** `docs(formal): hand off the model and proof obligations`.

## Final verification and handoff

From a clean macOS ARM64 clone with #4's pinned environment, run `python3 formal/model/run.py compile`, `scenario`, `prove --all`, and `check-results`. Confirm all eight required groups and every registered claim are complete, satisfiable, and traceable; compare source hashes and preserve the exact commands/logs. Report any claim that exceeds the budget as unresolved, with its failing evidence and required redesign. #32 closes only when its own claims and handoff are complete; #33/#34 remain separately responsible for fixed implementation artifacts.
