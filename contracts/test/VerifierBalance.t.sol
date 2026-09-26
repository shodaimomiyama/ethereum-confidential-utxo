// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {RangeBalanceVerifier} from "../src/verifier/RangeBalanceVerifier.sol";
import {BalanceProofV3} from "../src/verifier/BalanceProofV3.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";

interface VmForBalance {
    function chainId(uint256 chainId) external;
    function prank(address caller) external;
}

contract BalanceChallengeProbe {
    function first(uint256[] memory candidates) external pure returns (uint256) {
        for (uint256 i; i < 256; ++i) {
            if (BalanceProofV3.isChallenge(candidates[i])) return candidates[i];
        }
        revert BalanceProofV3.ChallengeExhausted();
    }
}

contract VerifierBalanceTest {
    VmForBalance private constant vm = VmForBalance(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function deploy() private returns (RangeBalanceVerifier verifier) {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        verifier = new RangeBalanceVerifier(base, gs, hs);
    }

    function test_validBalanceShapesIncludingIdentityX() public {
        RangeBalanceVerifier verifier = deploy();
        for (uint256 i; i < 5; ++i) {
            (
                address pool,
                uint256 chainId,
                bytes32 operationId,
                uint256 Xx,
                uint256 Xy,
                uint256 Rx,
                uint256 Ry,
                uint256 s
            ) = VerifierVectors.balanceProof(i);
            vm.chainId(chainId);
            vm.prank(pool);
            require(verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, s), "valid balance rejected");
        }
    }

    function test_contextChangesRejectNonIdentityXButNotIdentityX() public {
        RangeBalanceVerifier verifier = deploy();
        (
            address pool,
            uint256 chainId,
            bytes32 operationId,
            uint256 Xx,
            uint256 Xy,
            uint256 Rx,
            uint256 Ry,
            uint256 s
        ) = VerifierVectors.balanceProof(0);
        vm.chainId(chainId);
        vm.prank(pool);
        require(verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, s));
        vm.chainId(chainId + 1);
        vm.prank(pool);
        require(!verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, s), "chain change accepted");
        vm.chainId(chainId);
        vm.prank(address(0x2222));
        require(!verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, s), "caller change accepted");
        vm.prank(pool);
        require(!verifier.verifyBalance(bytes32(uint256(operationId) ^ 1), Xx, Xy, Rx, Ry, s));
        vm.prank(pool);
        require(!verifier.verifyBalance(operationId, 0, 0, Rx, Ry, s), "changed X accepted");
        vm.prank(pool);
        require(!verifier.verifyBalance(operationId, Xx, Xy, Xx, Xy, s), "changed R accepted");
        vm.prank(pool);
        require(!verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, s + 1), "changed s accepted");

        (pool, chainId, operationId, Xx, Xy, Rx, Ry, s) = VerifierVectors.balanceProof(2);
        vm.chainId(chainId + 1);
        vm.prank(address(0x2222));
        require(verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, s), "identity X rejected");
    }

    function test_badEquationReturnsFalseAndBadInputsRevert() public {
        RangeBalanceVerifier verifier = deploy();
        (
            address pool,
            uint256 chainId,
            bytes32 operationId,
            uint256 Xx,
            uint256 Xy,
            uint256 Rx,
            uint256 Ry,
            uint256 s
        ) = VerifierVectors.balanceProof(6);
        vm.chainId(chainId);
        vm.prank(pool);
        require(!verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, s), "bad s=0 equation accepted");
        vm.prank(pool);
        try verifier.verifyBalance(operationId, Xx, Xy, 0, 0, s) {
            revert("identity R accepted");
        } catch {}
        vm.prank(pool);
        try verifier.verifyBalance(operationId, Xx, Xy, Rx, Ry, Q) {
            revert("noncanonical s accepted");
        } catch {}
        vm.prank(pool);
        try verifier.verifyBalance(operationId, Xx, Xy, 1, 1, s) {
            revert("off-curve R accepted");
        } catch {}
        vm.prank(pool);
        try verifier.verifyBalance(operationId, 1, 1, Rx, Ry, s) {
            revert("off-curve X accepted");
        } catch {}
    }

    function test_challengeCandidateBoundsAndExhaustion() public {
        BalanceChallengeProbe probe = new BalanceChallengeProbe();
        uint256[] memory candidates = new uint256[](256);
        candidates[0] = 0;
        candidates[1] = Q;
        candidates[2] = type(uint256).max;
        candidates[3] = 1;
        require(probe.first(candidates) == 1);
        candidates[3] = Q - 1;
        require(probe.first(candidates) == Q - 1);
        candidates[3] = 0;
        try probe.first(candidates) {
            revert("exhausted candidates accepted");
        } catch {}
    }

    function test_publicSelectors() public pure {
        require(RangeBalanceVerifier.verifyBalance.selector == VerifierVectors.BALANCE_SELECTOR);
        require(
            bytes4(keccak256("verify(bytes32,uint256,uint256[10],uint256[5],uint256[],uint256[])"))
                == VerifierVectors.RANGE_SELECTOR
        );
    }
}
