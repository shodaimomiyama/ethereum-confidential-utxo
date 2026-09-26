// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {RangeBalanceVerifier} from "../src/verifier/RangeBalanceVerifier.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";

contract VerifierArtifactTest {
    function test_normalCodeAndFullInitcodeLimits() public pure {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        require(type(RangeBalanceVerifier).runtimeCode.length <= 24576, "runtime exceeds EIP-170");
        require(
            type(RangeBalanceVerifier).creationCode.length + abi.encode(base, gs, hs).length <= 49152,
            "full initcode exceeds EIP-3860"
        );
    }
}
