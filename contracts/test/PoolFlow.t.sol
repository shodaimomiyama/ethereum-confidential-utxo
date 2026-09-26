// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pool} from "../src/Pool.sol";
import {IPool} from "../src/IPool.sol";
import {PoolTypes} from "../src/PoolTypes.sol";
import {RangeBalanceVerifier} from "../src/verifier/RangeBalanceVerifier.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";
import {PoolVectors} from "./fixtures/PoolVectors.sol";

interface VmPool {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function etch(address target, bytes calldata code) external;
    function deal(address account, uint256 amount) external;
    function chainId(uint256 chainId) external;
    function prank(address caller) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract PoolFlowTest {
    VmPool private constant vm = VmPool(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deploy() private returns (Pool pool) {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeBalanceVerifier verifier = new RangeBalanceVerifier(base, gs, hs);
        Pool deployed = new Pool(address(verifier));
        vm.etch(PoolVectors.FIXED_POOL, address(deployed).code);
        pool = Pool(payable(PoolVectors.FIXED_POOL));
        vm.chainId(31337);
        vm.deal(address(this), 1 << 80);
    }

    function run(Pool pool, string memory name, uint256 amount) private {
        bytes memory callData = PoolVectors.calldataFor(name);
        (bool ok, bytes memory response) = address(pool).call{value: amount}(callData);
        if (!ok) {
            if (response.length >= 4) {
                bytes4 selector;
                assembly { selector := mload(add(response, 32)) }
                revert(string.concat("fixture failed: ", name, " selector ", _hex(selector)));
            }
            revert(string.concat("fixture failed: ", name));
        }
        require(pool.isOperationExecuted(PoolVectors.operationId(name)), "operation not recorded");
    }

    function _hex(bytes4 value) private pure returns (string memory) {
        bytes memory output = new bytes(8);
        bytes16 alphabet = "0123456789abcdef";
        uint32 number = uint32(value);
        for (uint256 i; i < 8; ++i) {
            output[i] = alphabet[(number >> (28 - i * 4)) & 15];
        }
        return string(output);
    }

    function test_realDepositAndFullTransfer() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        bytes32 first = PoolVectors.outputId("DEPOSIT_TEN", 0);
        (uint8 status,,,) = pool.getUtxo(first);
        require(status == 1, "deposit output missing");
        run(pool, "TRANSFER_FULL", 0);
        (status,,,) = pool.getUtxo(first);
        require(status == 2, "input not spent");
        (status,,,) = pool.getUtxo(PoolVectors.outputId("TRANSFER_FULL", 0));
        require(status == 1, "transfer output missing");
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 10 && liability == 10 && excess == 0, "bad accounting");
    }

    function test_recipientCanSpendReceivedUtxo() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        run(pool, "TRANSFER_FULL", 0);
        bytes32 received = PoolVectors.outputId("TRANSFER_FULL", 0);
        (uint8 status, address recipient,,) = pool.getUtxo(received);
        require(status == 1 && recipient != address(0), "receipt missing");
        run(pool, "RECIPIENT_REUSE", 0);
        (status,,,) = pool.getUtxo(received);
        require(status == 2, "recipient input not spent");
        (status,,,) = pool.getUtxo(PoolVectors.outputId("RECIPIENT_REUSE", 0));
        require(status == 1, "recipient output missing");
    }

    function test_nonIdentityBalanceProofAndContextBinding() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_BLIND", 1);
        vm.chainId(31338);
        (bool ok, bytes memory response) = address(pool).call(PoolVectors.calldataFor("TRANSFER_BLIND"));
        require(!ok && bytes4(response) == IPool.InvalidAuthorization.selector, "changed chain accepted");
        vm.chainId(31337);
        run(pool, "TRANSFER_BLIND", 0);
        (uint256 balance, uint256 liability,) = pool.getAccounting();
        require(balance == 1 && liability == 1, "blinded transfer accounting");

        address otherPool = address(0x2222);
        vm.etch(otherPool, address(pool).code);
        (ok, response) = otherPool.call{value: 1}(PoolVectors.calldataFor("DEPOSIT_BLIND"));
        require(!ok && bytes4(response) == IPool.InvalidAuthorization.selector, "changed Pool accepted");
    }

    function test_realPartialAndWithdrawal() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        run(pool, "TRANSFER_PARTIAL", 0);
        (uint8 status,,,) = pool.getUtxo(PoolVectors.outputId("TRANSFER_PARTIAL", 1));
        require(status == 1, "change missing");
    }

    function test_realFullWithdrawal() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        run(pool, "WITHDRAW_FULL", 0);
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 0 && liability == 0 && excess == 0, "bad final accounting");
    }

    function test_realPartialWithdrawal() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        run(pool, "WITHDRAW_PARTIAL", 0);
        (uint8 status,,,) = pool.getUtxo(PoolVectors.outputId("WITHDRAW_PARTIAL", 0));
        require(status == 1, "withdrawal remainder missing");
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 7 && liability == 7 && excess == 0, "partial withdrawal accounting");
    }

    function test_selfMerge() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TWO", 2);
        run(pool, "DEPOSIT_THREE", 3);
        run(pool, "SELF_MERGE", 0);
        (uint8 status,,,) = pool.getUtxo(PoolVectors.outputId("SELF_MERGE", 0));
        require(status == 1, "self merge output missing");
    }

    function test_recreateSameCommitmentHasNewOutputId() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        run(pool, "RECREATE", 0);
        bytes32 oldId = PoolVectors.outputId("DEPOSIT_TEN", 0);
        bytes32 newId = PoolVectors.outputId("RECREATE", 0);
        require(oldId != newId, "output ID reused");
        (uint8 spent,, uint256 oldX, uint256 oldY) = pool.getUtxo(oldId);
        (uint8 live,, uint256 newX, uint256 newY) = pool.getUtxo(newId);
        require(spent == 2 && live == 1 && oldX == newX && oldY == newY, "same commitment recreation");
    }

    function test_realConsolidationAndSelfOperations() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TWO", 2);
        run(pool, "DEPOSIT_THREE", 3);
        run(pool, "CONSOLIDATE", 0);
        (uint8 status,,,) = pool.getUtxo(PoolVectors.outputId("CONSOLIDATE", 0));
        require(status == 1, "consolidation output missing");
        (uint256 balance, uint256 liability,) = pool.getAccounting();
        require(balance == 5 && liability == 5, "consolidation accounting");

        pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        run(pool, "SELF_SPLIT", 0);
        (status,,,) = pool.getUtxo(PoolVectors.outputId("SELF_SPLIT", 1));
        require(status == 1, "self change missing");
    }

    function test_maxBoundaryTransfer() public {
        Pool pool = deploy();
        uint256 m = 1 << 64;
        run(pool, "DEPOSIT_MAX_A", m);
        run(pool, "DEPOSIT_MAX_B", m);
        run(pool, "TWO_MAX_OUTPUTS", 0);
        (uint256 balance, uint256 liability,) = pool.getAccounting();
        require(balance == 2 * m && liability == 2 * m, "M+M accounting");
    }

    function test_maxBoundaryWithdrawal() public {
        Pool pool = deploy();
        uint256 m = 1 << 64;
        run(pool, "DEPOSIT_MAX_A", m);
        run(pool, "DEPOSIT_MAX_B", m);
        run(pool, "WITHDRAW_MAX", 0);
        (uint256 balance, uint256 liability,) = pool.getAccounting();
        require(balance == 0 && liability == 0, "W accounting");
    }

    function test_authorizedRelayerAndReplayCompetition() public {
        Pool pool = deploy();
        run(pool, "DEPOSIT_TEN", 10);
        bytes memory data = PoolVectors.calldataFor("TRANSFER_FULL");
        vm.prank(address(0x4444));
        (bool ok,) = address(pool).call(data);
        require(ok, "authorized relayer rejected");
        bytes memory response;
        (ok, response) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(!ok && bytes4(response) == IPool.OperationAlreadyExecuted.selector, "replay accepted");
        (ok, response) = address(pool).call(PoolVectors.calldataFor("WITHDRAW_FULL"));
        require(!ok && bytes4(response) == IPool.InputAlreadySpent.selector, "spent input accepted");
    }

    function test_eventOrderAndPayloads() public {
        Pool pool = deploy();
        vm.recordLogs();
        run(pool, "DEPOSIT_TEN", 10);
        VmPool.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2, "deposit event count");
        bytes32 op = PoolVectors.operationId("DEPOSIT_TEN");
        bytes32 outputId = PoolVectors.outputId("DEPOSIT_TEN", 0);
        bytes memory data = PoolVectors.calldataFor("DEPOSIT_TEN");
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        (PoolTypes.OperationRequest memory request,,) =
            abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, bytes));
        require(logs[0].emitter == address(pool) && logs[0].topics.length == 4, "output emitter/topics");
        require(
            logs[0].topics[0] == keccak256("OutputCreated(address,bytes32,bytes32,uint256,uint256,uint256,uint8,bytes)")
        );
        require(
            logs[0].topics[1] == bytes32(uint256(uint160(request.owner))) && logs[0].topics[2] == outputId
                && logs[0].topics[3] == op,
            "output indexed fields"
        );
        require(
            keccak256(logs[0].data)
                == keccak256(
                    abi.encode(
                        uint256(0),
                        request.outputs[0].Cx,
                        request.outputs[0].Cy,
                        request.outputs[0].receiptFormat,
                        request.outputs[0].packet
                    )
                ),
            "output event data"
        );
        require(
            logs[1].topics[0]
                == keccak256(
                    "OperationSucceeded(bytes32,uint8,address,bytes32[],bytes32[],uint256,uint256,address,bytes32)"
                )
        );
        require(
            logs[1].topics[1] == op && logs[1].topics[2] == bytes32(uint256(uint160(request.owner))),
            "operation indexed fields"
        );
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = outputId;
        require(
            keccak256(logs[1].data)
                == keccak256(
                    abi.encode(uint8(0), request.inputIds, ids, request.d, request.w, request.destination, request.salt)
                ),
            "operation event data"
        );

        vm.recordLogs();
        run(pool, "TRANSFER_FULL", 0);
        logs = vm.getRecordedLogs();
        require(logs.length == 3, "transfer event count");
        require(logs[0].topics[0] == keccak256("InputConsumed(bytes32,bytes32)"), "input event order");
        require(
            logs[1].topics[0]
                == keccak256("OutputCreated(address,bytes32,bytes32,uint256,uint256,uint256,uint8,bytes)"),
            "output order"
        );
        require(
            logs[2].topics[0]
                == keccak256(
                    "OperationSucceeded(bytes32,uint8,address,bytes32[],bytes32[],uint256,uint256,address,bytes32)"
                ),
            "success order"
        );
    }
}
