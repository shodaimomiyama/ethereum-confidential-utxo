// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pool} from "../src/Pool.sol";
import {IPool} from "../src/IPool.sol";
import {PoolTypes} from "../src/PoolTypes.sol";
import {PoolVectors} from "./fixtures/PoolVectors.sol";

interface VmPoolAuth {
    function etch(address target, bytes calldata code) external;
    function deal(address account, uint256 amount) external;
    function chainId(uint256 chainId) external;
}

contract TrueVerifier {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

contract PoolAuthorizationTest {
    VmPoolAuth private constant vm = VmPoolAuth(address(uint160(uint256(keccak256("hevm cheat code")))));

    function deploy() private returns (Pool pool) {
        Pool source = new Pool(address(new TrueVerifier()));
        vm.etch(PoolVectors.FIXED_POOL, address(source).code);
        pool = Pool(payable(PoolVectors.FIXED_POOL));
        vm.deal(address(this), 100);
        vm.chainId(31337);
    }

    function depositParts()
        private
        returns (
            PoolTypes.OperationRequest memory request,
            PoolTypes.BalanceProof memory balance,
            bytes memory signature
        )
    {
        bytes memory data = PoolVectors.calldataFor("DEPOSIT_TEN");
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        return abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, bytes));
    }

    function assertError(bool ok, bytes memory response, bytes4 expected) private pure {
        require(!ok, "unexpected success");
        bytes4 actual;
        if (response.length >= 4) {
            assembly { actual := mload(add(response, 32)) }
        }
        require(actual == expected, "wrong error selector");
    }

    function test_rejectsZeroOutputOwnerAndMalformedShapes() public {
        Pool pool = deploy();
        (PoolTypes.OperationRequest memory request, PoolTypes.BalanceProof memory balance, bytes memory signature) =
            depositParts();
        request.outputs[0].owner = address(0);
        (bool ok, bytes memory response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);
        request.outputs[0].owner = request.owner;
        request.destination = address(0xABCD);
        (ok, response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);
        request.destination = address(0);
        request.d = 0;
        (ok, response) = address(pool).call(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.PublicAmountOutOfRange.selector);
        request.d = 10;
        request.outputs[0].packet = hex"1234";
        (ok, response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);
    }

    function test_invalidSignatureFormsAndWrongOwner() public {
        Pool pool = deploy();
        (PoolTypes.OperationRequest memory request, PoolTypes.BalanceProof memory balance, bytes memory signature) =
            depositParts();
        bytes memory shortSignature = new bytes(64);
        (bool ok, bytes memory response) = address(pool).call{value: 10}(
            abi.encodeWithSelector(IPool.deposit.selector, request, balance, shortSignature)
        );
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        signature[64] = 0x1d;
        (ok, response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        (,, signature) = depositParts();
        for (uint256 i = 32; i < 64; ++i) {
            signature[i] = 0xff;
        }
        (ok, response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        (,, signature) = depositParts();
        request.owner = address(0x1234);
        request.outputs[0].owner = request.owner;
        (ok, response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
    }

    function test_zeroWithdrawalDestinationAndInputOrdering() public {
        Pool pool = deploy();
        bytes memory data = PoolVectors.calldataFor("WITHDRAW_FULL");
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        (
            PoolTypes.OperationRequest memory request,
            PoolTypes.BalanceProof memory balance,
            PoolTypes.RangeProofV3[] memory ranges,
            bytes memory signature
        ) = abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, PoolTypes.RangeProofV3[], bytes));
        request.destination = address(0);
        (bool ok, bytes memory response) =
            address(pool).call(abi.encodeWithSelector(IPool.withdraw.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);

        data = PoolVectors.calldataFor("CONSOLIDATE");
        body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        (request, balance, ranges, signature) =
            abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, PoolTypes.RangeProofV3[], bytes));
        bytes32 first = request.inputIds[0];
        request.inputIds[0] = request.inputIds[1];
        request.inputIds[1] = first;
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);
        request.inputIds[1] = request.inputIds[0];
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.DuplicateInput.selector);
    }

    function test_publicAmountBoundsAndMsgValue() public {
        Pool pool = deploy();
        (PoolTypes.OperationRequest memory request, PoolTypes.BalanceProof memory balance, bytes memory signature) =
            depositParts();
        request.d = (1 << 64) + 1;
        (bool ok, bytes memory response) =
            address(pool).call(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.PublicAmountOutOfRange.selector);
        request.d = 10;
        (ok, response) =
            address(pool).call{value: 9}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.MsgValueMismatch.selector);

        bytes memory data = PoolVectors.calldataFor("WITHDRAW_FULL");
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        PoolTypes.RangeProofV3[] memory ranges;
        (request, balance, ranges, signature) =
            abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, PoolTypes.RangeProofV3[], bytes));
        request.w = (1 << 65) + 1;
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.withdraw.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.PublicAmountOutOfRange.selector);
    }

    function test_initialGetters() public {
        Pool pool = deploy();
        (uint8 status, address owner, uint256 x, uint256 y) = pool.getUtxo(bytes32(uint256(1)));
        require(status == 0 && owner == address(0) && x == 0 && y == 0);
        require(!pool.isOperationExecuted(bytes32(uint256(1))));
        (uint256 balance, uint256 liability, uint256 excess) = pool.getAccounting();
        require(balance == 0 && liability == 0 && excess == 0);
    }
}
