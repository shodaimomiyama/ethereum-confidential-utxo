// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PoolTypes} from "../src/PoolTypes.sol";
import {PoolBinding} from "../src/PoolBinding.sol";
import {PoolVectors} from "./fixtures/PoolVectors.sol";

contract PoolBindingProbe {
    function id(PoolTypes.OperationRequest calldata request, uint256 chainId, address pool)
        external
        pure
        returns (bytes32)
    {
        return PoolBinding.operationId(request, chainId, pool);
    }

    function digest(bytes32 id_, address owner, uint256 chainId, address pool) external pure returns (bytes32) {
        return PoolBinding.authorizationDigest(id_, owner, chainId, pool);
    }

    function output(bytes32 id_, uint256 index) external pure returns (bytes32) {
        return PoolBinding.outputId(id_, index);
    }
}

contract PoolBindingTest {
    function request(string memory name) private returns (PoolTypes.OperationRequest memory result) {
        bytes memory callData = PoolVectors.calldataFor(name);
        bytes memory body = new bytes(callData.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = callData[i + 4];
        }
        (result,,) = abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, bytes));
    }

    function test_operationIdMatchesIndependentVector() public {
        PoolBindingProbe probe = new PoolBindingProbe();
        PoolTypes.OperationRequest memory deposit = request("DEPOSIT_TEN");
        bytes32 id_ = probe.id(deposit, 31337, PoolVectors.FIXED_POOL);
        require(id_ == PoolVectors.operationId("DEPOSIT_TEN"), "operation id");
        require(probe.output(id_, 0) == PoolVectors.outputId("DEPOSIT_TEN", 0), "output id");
        require(probe.id(deposit, 31338, PoolVectors.FIXED_POOL) != id_, "chain binding");
        require(probe.id(deposit, 31337, address(0x2222)) != id_, "pool binding");
        require(
            probe.digest(id_, deposit.owner, 31337, PoolVectors.FIXED_POOL)
                != probe.digest(id_, deposit.owner, 31338, PoolVectors.FIXED_POOL),
            "digest chain binding"
        );
    }
}
