![Dim — Lightweight privacy for amounts on Ethereum](apps/uniswap-web/public/assets/brand/dim-cover.png)

# Dim

Confidential ETH UTXOs on Ethereum, with public Uniswap payments.

[日本語](README.ja.md) · [Use the app](#use-the-app) · [Run the apps locally](#run-the-apps-locally) · [Scope and workflow](#scope-and-workflow) · [Confidentiality limits](#confidentiality-limits) · [Reproduce the benchmark](#reproduce-the-prior-eip-benchmark) · [Documentation](#documentation)

## Overview

This project studies confidential ETH transfers on Ethereum while keeping the relationships between consumed and created UTXOs public. The research prototype supports ETH deposits, confidential transfers, and public withdrawals. Its Uniswap integration exchanges a fixed amount of ETH for a public token, delivers all swap proceeds to a designated recipient, and lets the payer reuse the remaining confidential UTXO. It is aimed at developers and researchers evaluating functionality, cost, security, and the limits of amount confidentiality as a basis for future standardization. The public transaction graph and known amounts can reveal transfer amounts or remaining balances.

## Use the app

The intended app experience is to receive a confidential test ETH reward, spend part of it through Uniswap, and reuse the remaining UTXO. The [introduction](https://dim.mmymshd52.workers.dev/) explains the project; [the app at `/app`](https://dim.mmymshd52.workers.dev/app) contains Demo reward, Pay, Deposit, and Withdraw.

**Availability:** the public deployment recorded on 2026-09-27 is a mock preview. The following walkthrough describes the live experience being implemented, not a completed public testnet run. At the README baseline `9542a8b`, changing `VITE_DIM_MODE` to `live` alone does not connect the app. Browser integration is tracked in [#59](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/59), reward distribution in [#58](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/58), and public deployment in [#73](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/73). The [development guide](docs/guides/development.md#webモックの静的公開) records the existing preview deployment.

### Prepare for live use

Use Chrome with MetaMask and a test wallet on Ethereum Sepolia. Keep public test ETH for transaction gas even when receiving a confidential reward; a confidential balance cannot pay that gas. For Deposit, the public balance must also cover the deposit amount. The configured **Get test ETH** link leads to an external faucet; Dim does not supply public gas ETH itself.

On a connected live deployment, the preparation controls are **Connect wallet**, **Switch to Sepolia**, **Prepare privacy key**, and **Recheck public balance**, as needed. Key preparation uses a dedicated wallet approval to derive the receipt key. Service login uses a separate SIWE signature; connecting the wallet or preparing the key does not by itself authenticate API requests. The final login UI is part of #59. Review the purpose of each wallet request before approving it.

Public ETH and available private ETH are separate balances. **Resync private balance** rechecks receipt data and spendability using the connected owner's key and public history. It does not create funds or make an unconfirmed receipt spendable. Switching accounts or networks changes the context in which balances and operations must be checked.

### Receive a reward, pay, and use the remainder

This example assumes an initially empty private balance and an available reward distributor. The amounts illustrate asset accounting; they are not faucet allowances, reward limits, gas estimates, or a fixed exchange rate. Inputs start empty.

| Step | What to enter and do | Expected result after confirmation and receipt checks |
| --- | --- | --- |
| Receive | In **Demo reward**, enter `0.01` in **Demo reward amount in ETH**, then choose **Request demo reward**. Follow the request in **Activity**. | The distributor transfers a `0.01 ETH` UTXO to you. **Distribution finalized; receipt pending** is not yet **Reward received**; only a verified receipt becomes available private ETH. |
| Pay | In **Pay privately**, enter `0.004` in **Pay amount in ETH**. Enter the final recipient's public address or choose **Use my address**. Review **Current terms**, **Estimated output**, **Minimum output**, **Deadline**, and **Selected UTXO**, then choose **Start private payment** and approve the required wallet requests. | The app selects one spendable input with a positive remainder. The entire `0.004 ETH` is exchanged for dUSD and all output dUSD goes to the recipient if the minimum is met. The `0.01 ETH` input is consumed; a `0.006 ETH` change UTXO becomes available after its receipt check. Gas is paid separately in public ETH. |
| Reuse | In **Withdraw**, select the `0.006 ETH` change under **UTXO to withdraw**, check the public destination, then choose **Withdraw full UTXO**. | That one UTXO is consumed and `0.006 ETH` is returned to the connected public address. Account for the withdrawal transaction's gas separately. No private change is created. |

Use the actual quote shown by the connected environment; live dUSD output depends on liquidity. **Minimum output in dUSD** and **Deadline (UTC timestamp)** let you set the acceptance conditions before authorization. If a refreshed quote changes the terms, review **Previous terms** and **New terms** and choose **Confirm new terms**. An expired or stale quote cannot be used to start payment.

Pay selects the input automatically; Withdraw lets you select one. Several smaller UTXOs whose total covers a payment do not necessarily provide a single usable input. Withdrawing one UTXO does not withdraw every UTXO you own. You can also use a verified remainder for another supported payment. Confidential transfers of that remainder are part of the core workflow, but there is no general confidential-transfer UI here.

### Deposit as an alternative

To use your own public test ETH instead of a reward, open **Deposit**, enter an amount such as `0.01` in **Deposit amount in ETH**, and choose **Start deposit**. Check the amount and gas separately in the wallet. A successful deposit lowers public ETH by the deposit amount plus gas and creates a matching private UTXO, usable only after receipt verification. You can then follow the same Pay and Withdraw steps above.

The deposit amount is public. Starting with a reward avoids making your own public deposit the obvious source amount, but the distributor still knows what it sent. The graph remains public, and subsequent public payments or withdrawals can expose earlier amounts. See [Confidentiality limits](#confidentiality-limits).

### Follow progress and recover

**Activity** remains visible when switching cards. A known transaction hash can expose **View on explorer** when the matching deployment's explorer is configured. A hash or an explorer success alone does not establish receipt verification or a usable private balance.

| Display or condition | Meaning and next action |
| --- | --- |
| **Request accepted** / **Distribution pending** | The reward request is recorded or awaiting distribution. Use **Recheck reward request** to follow the same request; do not turn an uncertain outcome into another reward request. |
| **Pending confirmation** | Submission is known, but the required chain confirmation has not been established. Keep following the existing operation. |
| **Status cannot be confirmed** | An RPC outage or missing submission response leaves the outcome unknown. Use **Recheck status** when available. Unknown is not failed; new spending or blind resubmission may remain blocked. |
| **On-chain success; receipt check pending** / **On-chain success; private receipt needs rechecking** | The chain operation succeeded, but its confidential receipt is pending or invalid. Recheck and resync; do not count its output as available funds. |
| **Attempt failed** | This attempt failed. Retry only when reconciliation permits **Retry same attempt**, preserving the existing operation and its authorization. A failed payment rolls back its asset effects, not its transaction gas. |
| **Not submitted** | When the operation is known not to have been submitted and recovery permits it, **Resume original submission** resumes the saved operation. This is different from retrying a failed on-chain attempt. |
| Gas shortage, stale quote, or changed terms | Obtain public gas ETH and recheck, or obtain and review current terms. The disabled action's explanation identifies the unmet condition. |
| Reorganization or stale balance | Reconcile the affected history with **Resync private balance** and operation rechecks before spending. Previously displayed receipt or balance data is not sufficient on its own. |

For live recovery, return with the same wallet and deployment, prepare the receipt key, authenticate as required, and reconcile saved operations with the service and chain. The design uses encrypted operation records and a browser cache; clearing browser storage is not a cancellation or proof that a transaction was never submitted. Cross-browser recovery and public-site acceptance remain tracked in [#46](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/46) and [#50](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/50). **Full history: Coming soon** is not a complete history viewer.

## Run the apps locally

### Components and current startup

| Path | Responsibility |
| --- | --- |
| [`apps/uniswap-web`](apps/uniswap-web/) | React/Vite introduction at `/` and the four-card app at `/app`. The browser integration uses shared client code for payments, receipt checks, and synchronization. |
| [`apps/uniswap-service`](apps/uniswap-service/) | Cloudflare Worker and Durable Object service for authentication, input reservations, saved operations, and the reward-distribution integration. It does not replace the browser's private receipt checks. |
| [`packages/uniswap`](packages/uniswap/) | Shared payment conditions, quotes, authorization, reconciliation, and service contracts, built on the core and Ethereum packages. |

Use Git, **Node.js 24.21.0**, and **pnpm 10.34.5**, with network access for dependencies. The prior-EIP benchmark's Node.js 22 environment is separate. With nvm and Corepack available, run from a fresh clone:

```bash
git clone https://github.com/shodaimomiyama/ethereum-confidential-utxo.git
cd ethereum-confidential-utxo
nvm install 24.21.0
nvm use 24.21.0
corepack enable pnpm
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm --filter @confidential-utxo/uniswap-web dev
```

Open the local URL printed by Vite, usually `http://localhost:5173/`, for the introduction. Open `/app` at that same origin for the app. Stop Vite with **Ctrl+C**. The existing entry point needs no prior contract/package build to show the UI preview. It defaults to mock mode, showing **Connect simulated wallet** and **Scenario workbench**; it needs no real wallet, RPC, Anvil, or testnet funds. These commands currently start that preview, not the complete live stack.

For site checks and a production asset build, run from the repository root:

```bash
pnpm --filter @confidential-utxo/crypto build
pnpm --filter @confidential-utxo/core build
pnpm check:site
pnpm test:site
pnpm build:site
```

Build output is `apps/uniswap-web/dist/`. The crypto/core builds supply the package outputs required by site type checks and tests in a fresh checkout. These commands check the frontend; they do not deploy contracts, start the service, or establish live acceptance. Core/contract setup and service checks have separate prerequisites described by the [development guide](docs/guides/development.md) and [root scripts](package.json).

### Connecting the live stack

The intended live stack needs a verified Pool/Adapter/Uniswap deployment, liquidity, a funded reward distributor, the service and its durable storage, and the browser controller connected to all of them. The site and API must share the configured HTTPS origin, and the chain, contract addresses, deployment generation, and service authentication settings must agree. The [integration architecture](docs/integration/uniswap/architecture.md) and [design](docs/integration/uniswap/design.md) define these boundaries.

At the README baseline, the standard browser entry point still lacks the live controller binding, and the service has test runtime configuration but no complete production startup command. Wallet/key handling, the cryptographic Worker, API authentication, encrypted operation storage, and recovery are the browser integration work in [#59](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/59); reward processing belongs to [#58](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/58). Their final wiring and the verified deployment from [#73](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/73) are needed before a reproducible live startup sequence can be given here.

### Frontend environment variables

The current names and defaults come from [`src/site/config.ts`](apps/uniswap-web/src/site/config.ts). Supply them to the Vite process, restart development after changing them, and rebuild before publishing changed assets. All six variables are optional in the current parser. `VITE_` values enter the public frontend bundle; they must not contain private keys, service secrets, or credential-bearing RPC URLs.

| Variable | Default | Purpose and constraints |
| --- | --- | --- |
| `VITE_DIM_MODE` | `mock` | Accepts only `mock` or `live`. `live` selects the live presentation; it does not create a controller, RPC connection, or service. Without the binding, `/app` shows **Dim app is not configured**. |
| `VITE_DIM_DEPLOYMENT_ID` | `local-v1` | Identifies the displayed deployment and explorer mapping. Whitespace is trimmed; blank uses the default. It is not a chain ID or a deployment manifest. |
| `VITE_DIM_CODE_URL` | Unset | Optional source-code link. |
| `VITE_DIM_EVIDENCE_URL` | Unset | Optional verification-evidence link. |
| `VITE_DIM_FAUCET_URL` | Unset | Optional external **Get test ETH** link. It does not fund the wallet. |
| `VITE_DIM_EXPLORER_BASE` | Unset | Explorer base for the selected deployment; live transaction links append `/tx/<hash>`. Without it, no explorer link is shown. Mock details remain local. |

Each of the four URL variables must be an absolute HTTPS URL when provided; omitted or whitespace-only values are unset. These are presentation settings, not the complete live deployment configuration. RPC/API configuration and service secrets still require the deployment setup tracked above.

### UI simulation for development

Mock mode is a tool for inspecting UI behavior while live integration progresses. **Advance simulation**, mock clocks, and scenario resets have no role in submitting or confirming live transactions. Simulated Sepolia labels and hashes are not chain records. The preview does not prove cryptographic security, real Uniswap execution, on-chain rollback, or production readiness.

For a manual preview of the walkthrough, choose **Connect simulated wallet**, **Switch to Sepolia**, **Prepare privacy key**, and **Recheck public balance**. Then request `0.01 ETH`, pay `0.004 ETH` to **Use my address**, and withdraw the `0.006 ETH` change. After starting each reward, payment, or deposit, press **Advance simulation** four times: approval, submission, chain success with receipt pending, and verified receipt. Withdraw uses three advances and has no private output receipt. No actual wallet approval or gas payment occurs. Mock quotes are synthetic; do not use their rate as a live price.

In **Scenario workbench**, choose an ID and press **Load scenario** to replace the current simulation with its starting state. Use **Next step** to apply the displayed scripted action, event, or time change until **Scenario complete**. Use **Reset scenario** to repeat that scenario. **Advance simulation** progresses manually started operations rather than advancing the script. **Mock clock (milliseconds)** and **Set clock** test time-sensitive UI conditions; **Effect journal** records simulated effects, not network transactions.

| Scenario ID | What to inspect after stepping through it |
| --- | --- |
| `S-27/hash-unknown` / `S-27/rpc-down` | Unknown status permits rechecking but blocks blind retry or a new payment. |
| `S-28/decryption-failed` | Chain success with an invalid receipt does not add spendable private balance. |
| `S-29/reorg-removes-adopted-change` | Reconciliation removes change previously treated as available. |
| `S-35/quote-age-exceeded` | A stale quote blocks payment. |
| `S-34/quote-changed-before-authorization` | Changed terms require explicit confirmation. |
| `S-35/gas-shortage` | Insufficient public gas blocks starting payment. |
| `S-39/pay-hash-known` | **View simulated transaction** opens local transaction details once the hash event is applied. |

Ordinary mock actions and advances are replayed from the current origin's `localStorage` key `dim-mock-session-v1` on reload when the owner/deployment scope matches. The selected scenario, workbench-injected events, script position, and mock clock are not a saved scenario session. An unsubmitted payment quote is invalidated on reload. **Reset scenario** resets the scenario; it is not the same as removing the saved session. To fully reset this preview, run the following in that origin's browser console, then prepare the simulated wallet again:

```javascript
localStorage.removeItem('dim-mock-session-v1');
location.reload();
```

This removes only mock session data. It is not a live recovery procedure. See the [scenario catalog](apps/uniswap-web/src/mock/scenario-catalog.ts), [mock persistence](apps/uniswap-web/src/mock/experience.ts), and [integration specification](docs/integration/uniswap/specification.md) for implementation and behavioral detail.

## Scope and workflow

The core provides an ETH-only, public-graph UTXO system, as described in the [core PRD](docs/PRD.md). The [Uniswap integration](docs/integration/uniswap/PRD.md) adds a way to spend part of a confidential ETH payment using public liquidity:

1. Deposit test ETH into an owner's UTXO, then transfer confidential ETH to another owner.
2. The recipient discovers the received UTXO, checks its amount and confirmed state, and can use it without further help from the sender.
3. The recipient, now acting as the payer, authorizes a fixed ETH amount, output token, minimum received amount, final recipient, and deadline. The integration exchanges that entire ETH amount and delivers all output tokens to the final recipient if the minimum is met.
4. The payer keeps the unspent ETH in a confidential UTXO and can transfer it again.

The integration supports a partial payment from one UTXO into one selected public token. A failed payment rolls back that attempt's UTXO consumption, remainder creation, withdrawal, swap, and token delivery together. Earlier confirmed transfers and transaction gas costs are outside that rollback.

This is research intended for local Ethereum and public testnets with test assets. The [integration specification](docs/integration/uniswap/specification.md) defines the required public demo site, including demo rewards, payments, deposits, and full withdrawals; the specification does not establish implementation or deployment completion. Production use with real funds, a general-purpose confidential wallet GUI, general confidential ERC-20 support, transaction-graph privacy, and exact-invoice settlement are outside the initial scope. Standard adoption and lower costs than prior approaches remain research goals.

## How it's made

The core tracks input existence and unspent status in contract storage and exposes UTXO consumption and creation relationships, following the [core specification](docs/specification.md). Every operation checks valid owner authorization bound to its intended effects and execution context. ETH deposits create matching UTXOs, transfers conserve the input value, and withdrawals preserve the sum of the public withdrawal and any confidential remainder. Unauthorized spending, double spending, and replay of successful operations are rejected. Gas is paid separately in public ETH.

Recipients discover, decrypt, and check receipt data using their keys and public history. The CLI distinguishes confirmed receipt from pending, failed, or unverified operations and supports resynchronization. The Uniswap integration binds the swap conditions to the owner's withdrawal authorization and rolls back all payment asset effects if the swap or delivery fails, following the [integration requirements](docs/integration/uniswap/requirements.md).

The [prior-EIP benchmark](benchmarks/prior-eips/) provides a separate measurement path for EIP-8182. Its Bash and JavaScript scripts build a pinned EIP-8182 reference implementation, generate Groth16 pool and demo-authorization proofs with snarkjs, and verify them on a local Anvil node using Foundry tools. They also exercise the reference demo's ML-KEM-768/X25519 receipt encryption and recovery from public logs. The [comparison report](docs/research/prior-eip-comparison.md) records the reference code, measurement conditions, development-key assumptions, and limitations.

## Confidentiality limits

Confidentiality concerns amounts. Transaction relationships remain public. Deposits and withdrawals reveal amounts, and the Uniswap path reveals the ETH spent, output token and amount, and final recipient. Hiding owners or transaction senders is not guaranteed. For example, a known input amount minus a public withdrawal reveals the remaining amount; a later full withdrawal can also reveal a past transfer amount. Keeping a remainder in a confidential UTXO does not by itself prevent inference.

See the [core privacy rules](docs/specification.md#公開情報と秘密の範囲), [required verification evidence](docs/requirements.md#検証結果として提供する成果物), and [integration privacy limits](docs/integration/uniswap/PRD.md#公開情報と機密性の限界).

## Reproduce the prior-EIP benchmark

The commands below run the EIP-8182 reference benchmark locally.

Prerequisites are Git, Bash, Node.js 22 with npm, Foundry (`forge`, `cast`, `anvil`), `jq`, and `shasum`, plus network access to fetch the reference implementation and dependencies. The [recorded environment](benchmarks/prior-eips/config.json) used macOS arm64, Node.js 22.22.0, npm 10.9.4, and Foundry 1.7.1. It records hardware and tool versions; it is not a minimum-resource specification or a claim of support for other operating systems.

Use a fresh scratch clone because the additional case scripts overwrite benchmark outputs inside the clone. Run commands from its repository root. The reference checkout path below should be unused for a fresh setup.

```bash
git clone https://github.com/shodaimomiyama/ethereum-confidential-utxo.git
cd ethereum-confidential-utxo
bash benchmarks/prior-eips/setup.sh /tmp/eip8182-clean
```

Setup pins the reference to `639baaf7b29c22eb43ba6150140902ea8dbbbc46`, installs dependencies, compiles circuits and contracts, and prepares development proving keys. A successful run prints the upstream commit and proving-asset hashes. The scripts use test-only keys and locally funded test assets; no personal credentials or real funds are needed.

Start a dedicated local node in a second terminal:

```bash
anvil --silent --host 127.0.0.1 --port 18545 --chain-id 1 --hardfork cancun --timestamp 1735689000 --gas-limit 30000000 --disable-code-size-limit
```

Back in the first terminal, run one warmup and three measured trials, then rebuild the aggregate from raw data:

```bash
bash benchmarks/prior-eips/repeat.sh /tmp/eip8182-clean http://127.0.0.1:18545 benchmarks/prior-eips/raw/new-run
node benchmarks/prior-eips/aggregate.mjs benchmarks/prior-eips/raw/new-run
```

Each trial resets the node. Successful aggregation checks the transfer receipt, rejection of the tampered authorization target, receipt recovery, and recorded state flags; it writes `aggregate.json` under `raw/new-run` and prints gas and timing medians. Exact timings and gas can vary between runs.

On the same dedicated node, reproduce all 17 encrypted operation cases, three additional ETH transfer trials, and the recipient's subsequent withdrawal:

```bash
bash benchmarks/prior-eips/cases/run-encrypted.sh /tmp/eip8182-clean http://127.0.0.1:18545 all
bash benchmarks/prior-eips/cases/repeat-eth.sh /tmp/eip8182-clean http://127.0.0.1:18545
bash benchmarks/prior-eips/recipient/run.sh /tmp/eip8182-clean http://127.0.0.1:18545
```

These scripts also reset the node. Expect 17 passing cases in [the encrypted-case summary](benchmarks/prior-eips/cases/encrypted-summary.json), three trials in [the ETH summary](benchmarks/prior-eips/cases/eth-repeat-summary.json), and a successful withdrawal of the received note in [the recipient result](benchmarks/prior-eips/recipient/reuse-result.json). Stop the dedicated node when finished.

The [comparison report](docs/research/prior-eip-comparison.md) links the [recorded raw trials](benchmarks/prior-eips/raw/repeated/) and [prior clean-checkout replay](benchmarks/prior-eips/raw/clean-replay-repeated/aggregate.json). It also explains the benchmark's mock token, demo authorization, development setup, and disabled code-size limit. These measurements do not establish this project's performance, production security, or deployability on an ordinary Ethereum network.

## Documentation

The technical source documents are in Japanese. Both READMEs link to the same sources.

For the macOS Apple Silicon setup, local RPC smoke test, and pinned K/Kontrol smoke proofs, see the [development guide](docs/guides/development.md).

| Document | Purpose |
| --- | --- |
| [Core PRD](docs/PRD.md) | Problem, intended users, initial scope, and standardization goals |
| [Core requirements](docs/requirements.md) | Functional, security, confidentiality, proof, evaluation, and reproducibility acceptance criteria |
| [Core specification](docs/specification.md) | State transitions, authorization, asset conservation, receipt, and synchronization rules |
| [Core architecture](docs/architecture.md) | Core components, implementation foundations, client boundaries, and planned repository and verification structure |
| [Core design (draft)](docs/design.md) | Protocol rules, authorization, receipt and synchronization, verification plans, and adoption evidence |
| [Uniswap integration PRD](docs/integration/uniswap/PRD.md) | Partial public payments from confidential ETH and reuse of the remainder |
| [Uniswap integration requirements](docs/integration/uniswap/requirements.md) | Authorization, rollback, confidentiality, cost, and reproducibility criteria |
| [Uniswap integration specification](docs/integration/uniswap/specification.md) | Payment acceptance, full delivery, rollback, synchronization, public site, and demo reward request rules |
| [Prior-EIP comparison](docs/research/prior-eip-comparison.md) | Comparison scope, measurement conditions, raw evidence, and limitations |
