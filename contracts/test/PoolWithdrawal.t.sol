// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pool} from "../src/Pool.sol";
import {IPool} from "../src/IPool.sol";
import {RangeBalanceVerifier} from "../src/verifier/RangeBalanceVerifier.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";
import {PoolVectors} from "./fixtures/PoolVectors.sol";

interface VmPoolWithdrawal {
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

contract CallbackReceiver {
    address public pool;
    bytes public reentry;
    uint256 public mode;
    bool public rejectedReentry;

    function configure(address target, bytes calldata callData, uint256 nextMode) external {
        pool = target;
        reentry = callData;
        mode = nextMode;
    }

    receive() external payable {
        if (mode == 1 || mode == 2) {
            (bool ok, bytes memory response) = pool.call(reentry);
            if (mode == 2) {
                if (!ok) {
                    assembly { revert(add(response, 32), mload(response)) }
                }
                revert("unexpected inner success");
            }
            bytes4 actual;
            if (response.length >= 4) {
                assembly { actual := mload(add(response, 32)) }
            }
            rejectedReentry = !ok && actual == IPool.ReentrantOperation.selector;
        } else if (mode == 3) {
            revert("receiver rejects ETH");
        } else if (mode == 4) {
            assembly { return(0, 100000) }
        } else if (mode == 5) {
            (bool ok,) = pool.call{value: 2}("");
            require(ok, "ETH return failed");
        }
    }
}

contract ForceEth {
    constructor() payable {}

    function send(address payable target) external {
        selfdestruct(target);
    }
}

contract PoolWithdrawalTest {
    VmPoolWithdrawal private constant vm = VmPoolWithdrawal(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant CALLBACK = 0x3333333333333333333333333333333333333333;

    function deploy() private returns (Pool pool) {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeBalanceVerifier verifier = new RangeBalanceVerifier(base, gs, hs);
        Pool source = new Pool(address(verifier));
        vm.etch(PoolVectors.FIXED_POOL, address(source).code);
        pool = Pool(payable(PoolVectors.FIXED_POOL));
        vm.chainId(31337);
        vm.deal(address(this), 100);
        (bool ok,) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(ok, "deposit failed");
    }

    function receiver(Pool pool, uint256 mode) private returns (CallbackReceiver target) {
        CallbackReceiver implementation = new CallbackReceiver();
        vm.etch(CALLBACK, address(implementation).code);
        target = CallbackReceiver(payable(CALLBACK));
        target.configure(address(pool), PoolVectors.calldataFor("DEPOSIT_TEN"), mode);
    }

    function test_caughtReentryPreservesOuterWithdrawal() public {
        Pool pool = deploy();
        CallbackReceiver target = receiver(pool, 1);
        (bool ok,) = address(pool).call(PoolVectors.calldataFor("WITHDRAW_CALLBACK_FULL"));
        require(ok && target.rejectedReentry(), "caught reentry failed");
        (uint256 balance, uint256 liability,) = pool.getAccounting();
        require(balance == 0 && liability == 0 && CALLBACK.balance == 10, "withdraw accounting");
    }

    function test_propagatedReentryAndRejectedReceiveRollback() public {
        Pool pool = deploy();
        CallbackReceiver target = receiver(pool, 2);
        (bool ok, bytes memory response) = address(pool).call(PoolVectors.calldataFor("WITHDRAW_CALLBACK_FULL"));
        require(!ok && bytes4(response) == IPool.WithdrawalFailed.selector, "propagated reentry accepted");
        require(
            !pool.isOperationExecuted(PoolVectors.operationId("WITHDRAW_CALLBACK_FULL")), "failed withdrawal recorded"
        );
        (uint8 status,,,) = pool.getUtxo(PoolVectors.outputId("DEPOSIT_TEN", 0));
        require(status == 1, "input spent after rollback");
        target.configure(address(pool), PoolVectors.calldataFor("DEPOSIT_TEN"), 3);
        (ok, response) = address(pool).call(PoolVectors.calldataFor("WITHDRAW_CALLBACK_FULL"));
        require(!ok && bytes4(response) == IPool.WithdrawalFailed.selector, "rejected receive accepted");
    }

    function test_selfWithdrawal() public {
        Pool pool = deploy();
        (bool ok,) = address(pool).call(PoolVectors.calldataFor("WITHDRAW_SELF"));
        require(ok, "self withdrawal rejected");
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 10 && liability == 0 && excess == 10, "self withdrawal accounting");
    }

    function test_ethReturnDuringCallback() public {
        Pool pool = deploy();
        CallbackReceiver target = receiver(pool, 5);
        vm.deal(address(target), 2);
        (bool ok,) = address(pool).call(PoolVectors.calldataFor("WITHDRAW_CALLBACK_FULL"));
        require(ok, "ETH-returning receiver rejected");
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 2 && liability == 0 && excess == 2, "returned ETH misaccounted");
    }

    function test_forcedEthAndLargeReturnData() public {
        Pool pool = deploy();
        ForceEth forced = new ForceEth{value: 7}();
        forced.send(payable(address(pool)));
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 17 && liability == 10 && excess == 7, "forced ETH misaccounted");
        receiver(pool, 4);
        (bool ok,) = address(pool).call(PoolVectors.calldataFor("WITHDRAW_CALLBACK_FULL"));
        require(ok, "large returndata rejected");
        (balance, liability, excess) = pool.getAccounting();
        require(balance == 7 && liability == 0 && excess == 7, "large returndata accounting");
    }

    function test_ordinaryReceiveDoesNotMint() public {
        Pool pool = deploy();
        vm.recordLogs();
        (bool ok,) = address(pool).call{value: 4}("");
        require(ok && vm.getRecordedLogs().length == 0, "ordinary receive emitted asset events");
        (uint8 status,,,) = pool.getUtxo(PoolVectors.outputId("DEPOSIT_TEN", 0));
        require(status == 1, "receive mutated UTXO");
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 14 && liability == 10 && excess == 4, "ordinary ETH misaccounted");
    }
}
