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

    function test_validRangeBoundariesAndIdentity() public {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeParameterProbe verifier = new RangeParameterProbe(base, gs, hs);
        uint256[4] memory caseIndices = [uint256(0), 1, 2, 4];
        for (uint256 i; i < caseIndices.length; ++i) {
            (
                bytes32 operationId,
                uint256 outputIndex,
                uint256[10] memory coords,
                uint256[5] memory scalars,
                uint256[] memory ls,
                uint256[] memory rs
            ) = VerifierVectors.rangeProof(caseIndices[i]);
            require(verifier.verify(operationId, outputIndex, coords, scalars, ls, rs), "valid range rejected");
        }
    }

    function test_polynomialAndInnerEquationFailuresReturnFalse() public {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeParameterProbe verifier = new RangeParameterProbe(base, gs, hs);
        (
            bytes32 operationId,
            uint256 outputIndex,
            uint256[10] memory coords,
            uint256[5] memory scalars,
            uint256[] memory ls,
            uint256[] memory rs
        ) = VerifierVectors.rangeProof(0);
        scalars[0] += 1;
        require(!verifier.verify(operationId, outputIndex, coords, scalars, ls, rs), "bad polynomial accepted");
        scalars[0] -= 1;
        scalars[3] += 1;
        require(!verifier.verify(operationId, outputIndex, coords, scalars, ls, rs), "bad inner product accepted");
    }

    function test_nonCanonicalRangePointReverts() public {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeParameterProbe verifier = new RangeParameterProbe(base, gs, hs);
        (
            bytes32 operationId,
            uint256 outputIndex,
            uint256[10] memory coords,
            uint256[5] memory scalars,
            uint256[] memory ls,
            uint256[] memory rs
        ) = VerifierVectors.rangeProof(0);
        coords[0] = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
        try verifier.verify(operationId, outputIndex, coords, scalars, ls, rs) {
            revert("invalid point accepted");
        } catch {}
    }

    function test_publishedRangeRejections() public {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeParameterProbe verifier = new RangeParameterProbe(base, gs, hs);
        (
            bytes32 operationId,
            uint256 outputIndex,
            uint256[10] memory coords,
            uint256[5] memory scalars,
            uint256[] memory ls,
            uint256[] memory rs
        ) = VerifierVectors.rangeProof(3);
        require(!verifier.verify(operationId, outputIndex, coords, scalars, ls, rs), "over max accepted");

        (operationId, outputIndex, coords, scalars, ls, rs) = VerifierVectors.rangeProof(0);
        require(!verifier.verify(bytes32(uint256(operationId) ^ 1), outputIndex, coords, scalars, ls, rs));
        require(!verifier.verify(operationId, outputIndex + 1, coords, scalars, ls, rs));

        uint256[] memory shortLs = new uint256[](11);
        try verifier.verify(operationId, outputIndex, coords, scalars, shortLs, rs) {
            revert("short proof accepted");
        } catch {}
        scalars[0] = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        try verifier.verify(operationId, outputIndex, coords, scalars, ls, rs) {
            revert("noncanonical scalar accepted");
        } catch {}
    }
}
