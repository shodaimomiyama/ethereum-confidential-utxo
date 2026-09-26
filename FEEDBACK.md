# Uniswap Developer Feedback

Prepared for ETHGlobal Tokyo 2026 from repository evidence available on September 27, 2026. This report describes a local integration experiment; it does not claim a completed public deployment. Test outcomes below are taken from committed execution records, not a new run performed while writing this report.

## Project and integration

Ethereum Confidential UTXO explores receiving ETH confidentially, spending part of it through a public Uniswap swap, and retaining the remainder in a confidential UTXO. The intended payment exchanges a fixed ETH amount for a public token and sends the entire swap output to a designated recipient. See the [integration requirements and intended use](docs/integration/uniswap/PRD.md).

The swap input, output token and amount, and recipient are public. The UTXO transaction graph is also public. Confidential change does not guarantee that its value cannot be inferred: a known input amount and public withdrawal can reveal it.

The recorded UX-01 experiment uses:

| Component | Recorded version or environment |
| --- | --- |
| Uniswap v2 Core | Commit `6a9e7c97860676e0992f22a49665760444c1cdf5` |
| Uniswap v2 Periphery / Router02 | Commit `ed24991304291297c3b4a52818d02f46a17aa9a2`, with the local patch described below |
| Uniswap solidity-lib | Commit `c01640b0f0f1d8a85cba8de378cc48469fcfd9a6` |
| Assets and route | WETH9 and project-defined demo token dUSD; `swapExactETHForTokens`, WETH → dUSD |
| Execution | Forge test EVM and a Forge test run against a local Anvil fork; chain ID 31337 |
| Build tools | Foundry 1.8.3; Solidity 0.5.16, 0.6.6, and 0.8.23 |

Sources: [pinned upstream revisions and patch](experiments/design/uniswap/ux01/provenance.json), [environment record](experiments/design/uniswap/ux01/outputs/environment.json), and [reproduction script](experiments/design/uniswap/ux01/run.sh).

The [experimental adapter, minimal Pool, and dUSD](experiments/design/uniswap/ux01/src/UX01.sol) and [integration tests](experiments/design/uniswap/ux01/test/UX01.t.sol) contain the exercised code. The [Router02 call at the evidence revision](https://github.com/shodaimomiyama/ethereum-confidential-utxo/blob/e13eb17755ae1ff6575916063b5b411653f79a01/experiments/design/uniswap/ux01/src/UX01.sol#L145) is the swap entry point. These are design experiments, not the final adapter implementation.

## Development experience and achieved scope

The recorded path was to pin upstream sources, compile the v2 contracts, prepare local liquidity, connect a minimal withdrawal boundary to Router02, and exercise payment authorization and asset rollback. The upstream contract source was useful as an executable integration target. Foundry provided the local build and test environment. No elapsed time to the first successful integration was recorded, and commit timestamps are not used to estimate it.

The [saved results](experiments/design/uniswap/ux01/outputs/result.json) report 9/9 tests passing in each of two runs. They cover full-input swaps with matching recipient balance increases, rejection of modified signed payment terms, deadline boundaries, replay rejection, and asset-state rollback when the minimum output is not met. Raw output is available for [Forge](experiments/design/uniswap/ux01/outputs/forge-test.log) and the [local Anvil-fork run](experiments/design/uniswap/ux01/outputs/anvil-fork-test.log).

The minimal Pool stores plaintext fixtures and does not validate the real confidential balance or range proofs. These tests therefore establish a local contract interaction boundary, not successful integration of the complete confidential system. They are not broadcast transactions on Anvil or Sepolia. Public deployment, the final Pool and adapter combination, browser operation, receipt-log rollback, and gas comparisons are outside this evidence.

## Blocker and workaround

**Expected:** the locally compiled Factory and Router02 would agree on the address of the WETH/dUSD Pair, allowing `addLiquidityETH` to initialize liquidity.

**Encountered:** the Pair creation-bytecode hash from the pinned local build differed from the init code hash embedded in the upstream periphery library. The [provenance record](experiments/design/uniswap/ux01/provenance.json) reports that `addLiquidityETH` consequently attempted to interact with an address without contract code. This blocked local liquidity setup. The original failed execution's raw trace is not included in the cited record.

**Workaround:** change the single init code hash constant in the locally vendored `UniswapV2Library.sol` to match the locally compiled Pair creation bytecode. The passing results apply to this patched deployment only. This is a local build compatibility issue; the evidence does not establish a defect in an official deployment or compatibility with other compiler settings.

Work on confidential proofs, wallet-derived keys, and application recovery belongs to our own system. It is not presented as a Uniswap defect or a request for Uniswap to solve those responsibilities.

## Suggestions

1. **Provide a reproducible v2 local-deployment recipe.** Pin compatible core/periphery revisions and compiler settings, deploy WETH and two test assets, add liquidity, and execute a swap. Include a check that the Pair creation-bytecode hash matches the periphery constant. This would help developers testing custom contract integrations without a public RPC dependency.
2. **Add a targeted troubleshooting example for Pair address mismatches.** Show how to compare the Factory's `getPair` result, the periphery's derived address, and deployed code before adding liquidity. Explain the difference between reproducing official artifacts and compiling a custom local deployment. A preflight failure identifying the mismatched hash would make this particular setup failure easier to diagnose.
3. **Include an atomic contract-composition test example.** Demonstrate a custom withdrawal followed by `swapExactETHForTokens`, with both success and minimum-output failure cases. Check the caller's state, Pair reserves, and recipient balances after failure. This would help applications that must roll back an earlier asset operation when a swap fails.

These are proposals based on this experiment. We have not established that equivalent guidance is absent from every official documentation page or example.

## Support and next steps

The repository identifies the upstream source snapshots used, but does not establish which documentation pages the developer personally consulted or how they rated them. Use of mentorship, office hours, or Discord support is not recorded. We therefore make no claim about the quality of assistance received. The concrete support request is a reproducible local setup and diagnostics for the compatibility problem above.

The project's tracked next steps include the [final adapter implementation (#56)](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/56), [real Pool integration tests (#45)](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/45), and [deployment work (#60)](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/60), coordinated in [#52](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/52). These are planned tasks, not evidence of completion or a confirmed commitment to continue after the hackathon.

## Submission follow-up

The [award requirements](https://ethglobal.com/events/tokyo2026/prizes/uniswap-foundation) also require a [Developer Feedback Form submission](https://developers.uniswap.org/hackathon-feedback) containing this file's public URL. Publishing this file does not submit the form; submission is not verified here. [Issue #69](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/69) tracks publication and the form handoff, while [#19](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/19) tracks README links to the integration contracts and code lines.
