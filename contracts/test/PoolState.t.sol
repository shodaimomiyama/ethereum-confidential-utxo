// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pool} from "../src/Pool.sol";
import {IPool} from "../src/IPool.sol";
import {PoolVectors} from "./fixtures/PoolVectors.sol";

interface VmPoolState {
    function etch(address target, bytes calldata code) external;
    function deal(address account, uint256 amount) external;
    function chainId(uint256 chainId) external;
}

contract StateTrueVerifier {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

contract PoolStateTest {
    VmPoolState private constant vm = VmPoolState(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deploy() private returns (Pool pool) {
        Pool source = new Pool(address(new StateTrueVerifier()));
        vm.etch(PoolVectors.FIXED_POOL, address(source).code);
        pool = Pool(payable(PoolVectors.FIXED_POOL));
        vm.chainId(31337);
        vm.deal(address(this), 100);
    }

    function test_absentLiveSpentGettersRetainCommitment() public {
        Pool pool = deploy();
        bytes32 id = PoolVectors.outputId("DEPOSIT_TEN", 0);
        (uint8 status, address owner, uint256 x, uint256 y) = pool.getUtxo(id);
        require(status == 0 && owner == address(0) && x == 0 && y == 0, "absent record");
        (bool ok,) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(ok, "deposit failed");
        (status, owner, x, y) = pool.getUtxo(id);
        require(status == 1 && owner != address(0) && x != 0 && y != 0, "live record");
        (ok,) = address(pool).call(PoolVectors.calldataFor("TRANSFER_FULL"));
        require(ok, "transfer failed");
        (uint8 spent, address savedOwner, uint256 savedX, uint256 savedY) = pool.getUtxo(id);
        require(spent == 2 && savedOwner == owner && savedX == x && savedY == y, "spent record changed");
    }

    function test_accountingDeficitRejectsQuery() public {
        Pool pool = deploy();
        (bool ok,) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(ok, "deposit failed");
        vm.deal(address(pool), 9);
        bytes memory response;
        (ok, response) = address(pool).staticcall(abi.encodeWithSelector(IPool.getAccounting.selector));
        require(!ok && bytes4(response) == IPool.AccountingInvariantViolation.selector, "deficit hidden");
    }
}
