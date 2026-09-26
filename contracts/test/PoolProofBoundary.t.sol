// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pool} from "../src/Pool.sol";
import {IPool} from "../src/IPool.sol";
import {PoolVectors} from "./fixtures/PoolVectors.sol";

interface VmPoolProof {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function etch(address target, bytes calldata code) external;
    function deal(address account, uint256 amount) external;
    function chainId(uint256 chainId) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract VerifierReplies {
    uint256 public mode;

    function setMode(uint256 value) external {
        mode = value;
    }

    fallback() external {
        uint256 current = mode;
        assembly {
            if and(gt(current, 6), eq(shr(224, calldataload(0)), 0x6dc0ced9)) {
                mstore(0, 1)
                return(0, 32)
            }
            switch current
            case 0 {
                mstore(0, 0)
                return(0, 32)
            }
            case 1 {
                mstore(0, 1)
                return(0, 32)
            }
            case 2 { revert(0, 0) }
            case 3 { return(0, 0) }
            case 4 {
                mstore(0, 1)
                return(0, 31)
            }
            case 5 {
                mstore(0, 1)
                return(0, 33)
            }
            case 6 {
                mstore(0, 2)
                return(0, 32)
            }
            case 7 {
                mstore(0, 0)
                return(0, 32)
            }
            case 8 { revert(0, 0) }
            case 9 { return(0, 0) }
            case 10 {
                mstore(0, 1)
                return(0, 31)
            }
            case 11 {
                mstore(0, 1)
                return(0, 33)
            }
            case 12 {
                mstore(0, 2)
                return(0, 32)
            }
        }
    }
}

contract PoolProofBoundaryTest {
    VmPoolProof private constant vm = VmPoolProof(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deploy() private returns (Pool pool, VerifierReplies replies) {
        replies = new VerifierReplies();
        Pool source = new Pool(address(replies));
        vm.etch(PoolVectors.FIXED_POOL, address(source).code);
        pool = Pool(payable(PoolVectors.FIXED_POOL));
        vm.chainId(31337);
        vm.deal(address(this), 100);
    }

    function selector(bytes memory response) private pure returns (bytes4 value) {
        if (response.length >= 4) {
            assembly { value := mload(add(response, 32)) }
        }
    }

    function test_badBalanceVerifierReplies() public {
        (Pool pool, VerifierReplies replies) = deploy();
        for (uint256 mode = 0; mode <= 6; ++mode) {
            if (mode == 1) continue;
            replies.setMode(mode);
            vm.recordLogs();
            (bool ok, bytes memory response) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
            require(!ok && selector(response) == IPool.InvalidBalanceProof.selector, "bad balance response accepted");
            require(vm.getRecordedLogs().length == 0, "failed proof emitted logs");
            require(!pool.isOperationExecuted(PoolVectors.operationId("DEPOSIT_TEN")), "failed operation recorded");
            require(address(pool).balance == 0, "failed operation kept ETH");
        }
        replies.setMode(1);
        (bool accepted,) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(accepted, "exact true rejected");
    }

    function test_rangeFailureMapsToOutputIndex() public {
        (Pool pool, VerifierReplies replies) = deploy();
        replies.setMode(1);
        (bool ok,) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(ok);
        bytes32 output = PoolVectors.outputId("DEPOSIT_TEN", 0);
        for (uint256 mode = 7; mode <= 12; ++mode) {
            replies.setMode(mode);
            vm.recordLogs();
            bytes memory response;
            (ok, response) = address(pool).call(PoolVectors.calldataFor("TRANSFER_FULL"));
            require(!ok && selector(response) == IPool.InvalidRangeProof.selector, "bad range response accepted");
            require(vm.getRecordedLogs().length == 0, "failed range proof emitted logs");
            (uint8 status,,,) = pool.getUtxo(output);
            require(status == 1, "input spent after failed range proof");
        }
    }
}
