# ethereum-confidential-utxo

English | [日本語](README.ja.md)

## Short description

Confidential ETH UTXO research prototype with public Uniswap payments.

## Description

This project studies confidential ETH transfers on Ethereum while keeping the relationships between consumed and created UTXOs public. The research prototype supports ETH deposits, confidential transfers, and public withdrawals. Its Uniswap integration exchanges a fixed amount of ETH for a public token, delivers all swap proceeds to a designated recipient, and lets the payer reuse the remaining confidential UTXO. It is aimed at developers and researchers evaluating functionality, cost, security, and the limits of amount confidentiality as a basis for future standardization. The public transaction graph and known amounts can reveal transfer amounts or remaining balances.

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
