// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {RangeProofV3} from "../src/verifier/RangeProofV3.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";

contract RangeParameterProbe is RangeProofV3 {
    constructor(uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) RangeProofV3(base, gs, hs) {}
}

contract VerifierRangeTest {
    bytes32 private constant PARAMETERS_HASH = 0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae;

    function test_parameterDigestAndRoleOrder() public {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeParameterProbe verifier = new RangeParameterProbe(base, gs, hs);
        require(verifier.parametersHash() == PARAMETERS_HASH);
        (uint256 hx, uint256 hy) = verifier.valueBase();
        (uint256 gx, uint256 gy) = verifier.blindingBase();
        require(hx == base[0] && hy == base[1] && gx == base[2] && gy == base[3]);
        for (uint256 i; i < 64; ++i) {
            (uint256 x, uint256 y) = verifier.gs(i);
            require(x == gs[i] && y == gs[64 + i], "g role mismatch");
            (x, y) = verifier.hs(i);
            require(x == hs[i] && y == hs[64 + i], "h role mismatch");
        }
    }

    function test_parameterMutationReverts() public {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        gs[0] ^= 1;
        try new RangeParameterProbe(base, gs, hs) {
            revert("mutated parameters deployed");
        } catch {}
    }
}
