// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "../src/verifier/Bn254.sol";
import {RangeBalanceVerifier} from "../src/verifier/RangeBalanceVerifier.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";

contract RawCallProbe {
    function invoke(address target, uint256 length) external view returns (bytes memory) {
        return Bn254.rawStaticCall(target, "", length);
    }
}

contract SyntheticReturn {
    uint256 private immutable length;
    uint256 private immutable value;
    bool private immutable shouldRevert;

    constructor(uint256 length_, uint256 value_, bool shouldRevert_) {
        length = length_;
        value = value_;
        shouldRevert = shouldRevert_;
    }

    fallback() external {
        if (shouldRevert) revert();
        uint256 n = length;
        uint256 v = value;
        assembly {
            mstore(0, v)
            return(0, n)
        }
    }
}

contract ExactBoolConsumer {
    function accepts(address target, bytes memory data) external view returns (bool) {
        (bool success, bytes memory result) = target.staticcall(data);
        if (!success || result.length != 32) return false;
        uint256 word;
        assembly { word := mload(add(result, 32)) }
        return word == 1;
    }
}

contract VerifierBoundaryTest {
    function deploy() private returns (RangeBalanceVerifier verifier) {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        verifier = new RangeBalanceVerifier(base, gs, hs);
    }

    function rangeCall() private pure returns (bytes memory) {
        (
            bytes32 op,
            uint256 index,
            uint256[10] memory coords,
            uint256[5] memory scalars,
            uint256[] memory ls,
            uint256[] memory rs
        ) = VerifierVectors.rangeProof(0);
        return abi.encodeWithSelector(VerifierVectors.RANGE_SELECTOR, op, index, coords, scalars, ls, rs);
    }

    function setWord(bytes memory data, uint256 offset, uint256 value) private pure {
        assembly { mstore(add(add(data, 32), offset), value) }
    }

    function test_rangeCalldataDecodeAndLengthBoundaries() public {
        RangeBalanceVerifier verifier = deploy();
        bytes memory valid = rangeCall();
        (bool success, bytes memory result) = address(verifier).staticcall(valid);
        require(success && result.length == 32 && abi.decode(result, (bool)), "valid range failed");
        uint256[4] memory cuts = [uint256(0), 3, 516, valid.length - 1];
        for (uint256 i; i < cuts.length; ++i) {
            bytes memory truncated = new bytes(cuts[i]);
            for (uint256 j; j < cuts[i]; ++j) {
                truncated[j] = valid[j];
            }
            (success,) = address(verifier).staticcall(truncated);
            require(!success, "truncated calldata accepted");
        }
        bytes memory badOffset = rangeCall();
        setWord(badOffset, 516, type(uint256).max);
        (success,) = address(verifier).staticcall(badOffset);
        require(!success, "bad dynamic offset accepted");
        bytes memory badLength = rangeCall();
        setWord(badLength, 580, type(uint256).max);
        (success,) = address(verifier).staticcall(badLength);
        require(!success, "bad dynamic length accepted");
        for (uint256 n = 11; n <= 13; n += 2) {
            (
                bytes32 op,
                uint256 index,
                uint256[10] memory coords,
                uint256[5] memory scalars,
                uint256[] memory ls,
                uint256[] memory rs
            ) = VerifierVectors.rangeProof(0);
            uint256[] memory resizedLs = new uint256[](n);
            for (uint256 j; j < n && j < ls.length; ++j) {
                resizedLs[j] = ls[j];
            }
            (success,) = address(verifier)
                .staticcall(
                    abi.encodeWithSelector(VerifierVectors.RANGE_SELECTOR, op, index, coords, scalars, resizedLs, rs)
                );
            require(!success, "bad L count accepted");
        }
        (
            bytes32 op2,
            uint256 index2,
            uint256[10] memory coords2,
            uint256[5] memory scalars2,
            uint256[] memory ls2,
            uint256[] memory rs2
        ) = VerifierVectors.rangeProof(0);
        assembly { mstore(rs2, 11) }
        (success,) = address(verifier)
            .staticcall(
                abi.encodeWithSelector(VerifierVectors.RANGE_SELECTOR, op2, index2, coords2, scalars2, ls2, rs2)
            );
        require(!success, "bad R count accepted");
        scalars2[0] += 1;
        (success, result) = address(verifier)
            .staticcall(
                abi.encodeWithSelector(
                    VerifierVectors.RANGE_SELECTOR, op2, index2, coords2, scalars2, ls2, VerifierVectorsR()
                )
            );
        require(success && result.length == 32 && !abi.decode(result, (bool)), "bad equation did not return false");
    }

    function VerifierVectorsR() private pure returns (uint256[] memory rs) {
        (,,,,, rs) = VerifierVectors.rangeProof(0);
    }

    function test_exactBoolConsumerAndVerifierDirectCalls() public {
        ExactBoolConsumer consumer = new ExactBoolConsumer();
        uint256[7] memory lengths = [uint256(32), 32, 0, 31, 33, 32, 32];
        uint256[7] memory values = [uint256(1), 0, 1, 1, 1, 2, 1];
        for (uint256 i; i < 7; ++i) {
            SyntheticReturn target = new SyntheticReturn(lengths[i], values[i], i == 6);
            require(consumer.accepts(address(target), "") == (i == 0), "consumer boundary mismatch");
        }
        RangeBalanceVerifier verifier = deploy();
        require(consumer.accepts(address(verifier), rangeCall()), "range direct call rejected");
        (
            address pool,
            uint256 chainId,
            bytes32 operationId,
            uint256 Xx,
            uint256 Xy,
            uint256 Rx,
            uint256 Ry,
            uint256 s
        ) = VerifierVectors.balanceProof(2);
        pool;
        chainId;
        require(
            consumer.accepts(
                address(verifier),
                abi.encodeWithSelector(VerifierVectors.BALANCE_SELECTOR, operationId, Xx, Xy, Rx, Ry, s)
            ),
            "balance direct call rejected"
        );
    }

    function test_rawPrecompileResponseLengths() public {
        RawCallProbe probe = new RawCallProbe();
        uint256[6] memory lengths = [uint256(0), 31, 33, 63, 65, 32];
        for (uint256 i; i < 6; ++i) {
            SyntheticReturn target = new SyntheticReturn(lengths[i], 1, i == 5);
            (bool success,) =
                address(probe).staticcall(abi.encodeWithSelector(RawCallProbe.invoke.selector, address(target), 32));
            require(!success, "invalid raw response accepted");
        }
    }
}
