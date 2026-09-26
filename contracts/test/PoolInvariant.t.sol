// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pool} from "../src/Pool.sol";
import {IPool} from "../src/IPool.sol";
import {RangeBalanceVerifier} from "../src/verifier/RangeBalanceVerifier.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";
import {PoolVectors} from "./fixtures/PoolVectors.sol";

interface VmPoolInvariant {
    function etch(address target, bytes calldata code) external;
    function deal(address account, uint256 amount) external;
    function chainId(uint256 chainId) external;
}

contract PoolInvariantTest {
    VmPoolInvariant private constant vm = VmPoolInvariant(address(uint160(uint256(keccak256("hevm cheat code")))));

    function test_liabilityEqualsKnownUnspentValuesAcrossSuccessAndFailure() public {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeBalanceVerifier verifier = new RangeBalanceVerifier(base, gs, hs);
        Pool source = new Pool(address(verifier));
        vm.etch(PoolVectors.FIXED_POOL, address(source).code);
        Pool pool = Pool(payable(PoolVectors.FIXED_POOL));
        vm.chainId(31337);
        vm.deal(address(this), 100);
        _run(pool, "DEPOSIT_TWO", 2);
        _run(pool, "DEPOSIT_THREE", 3);
        _accounting(pool, 5, 5, 0);
        _run(pool, "CONSOLIDATE", 0);
        _accounting(pool, 5, 5, 0);
        bytes32 first = PoolVectors.outputId("DEPOSIT_TWO", 0);
        bytes32 second = PoolVectors.outputId("DEPOSIT_THREE", 0);
        bytes32 four = PoolVectors.outputId("CONSOLIDATE", 0);
        bytes32 one = PoolVectors.outputId("CONSOLIDATE", 1);
        _status(pool, first, 2);
        _status(pool, second, 2);
        _status(pool, four, 1);
        _status(pool, one, 1);
        (bool ok, bytes memory response) = address(pool).call(PoolVectors.calldataFor("SELF_MERGE"));
        require(!ok && bytes4(response) == IPool.InputAlreadySpent.selector, "spent inputs accepted");
        _accounting(pool, 5, 5, 0);
        _status(pool, four, 1);
        _status(pool, one, 1);
        require(!pool.isOperationExecuted(PoolVectors.operationId("SELF_MERGE")), "failed operation recorded");
    }

    function _run(Pool pool, string memory name, uint256 value) private {
        (bool ok,) = address(pool).call{value: value}(PoolVectors.calldataFor(name));
        require(ok, "fixture failed");
    }

    function _accounting(Pool pool, uint256 actual, uint256 liability, uint256 excess) private view {
        (uint256 gotActual, uint256 gotLiability, uint256 gotExcess) = pool.getAccounting();
        require(gotActual == actual && gotLiability == liability && gotExcess == excess, "B=L+E failed");
    }

    function _status(Pool pool, bytes32 id, uint8 expected) private view {
        (uint8 status,,,) = pool.getUtxo(id);
        require(status == expected, "bad UTXO status");
    }
}
