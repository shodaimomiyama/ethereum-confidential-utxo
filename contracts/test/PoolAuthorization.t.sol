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
    function store(address target, bytes32 slot, bytes32 value) external;
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

    function transferParts(string memory name)
        private
        returns (
            PoolTypes.OperationRequest memory request,
            PoolTypes.BalanceProof memory balance,
            PoolTypes.RangeProofV3[] memory ranges,
            bytes memory signature
        )
    {
        bytes memory data = PoolVectors.calldataFor(name);
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        return abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, PoolTypes.RangeProofV3[], bytes));
    }

    function test_rejectsThreeInputsExcessOutputsAndWrongProofCount() public {
        Pool pool = deploy();
        (
            PoolTypes.OperationRequest memory request,
            PoolTypes.BalanceProof memory balance,
            PoolTypes.RangeProofV3[] memory ranges,
            bytes memory signature
        ) = transferParts("CONSOLIDATE");
        bytes32[] memory threeInputs = new bytes32[](3);
        threeInputs[0] = request.inputIds[0];
        threeInputs[1] = request.inputIds[1];
        threeInputs[2] = bytes32(type(uint256).max);
        request.inputIds = threeInputs;
        (bool ok, bytes memory response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);

        (request, balance, ranges, signature) = transferParts("TRANSFER_PARTIAL");
        PoolTypes.Output[] memory threeOutputs = new PoolTypes.Output[](3);
        threeOutputs[0] = request.outputs[0];
        threeOutputs[1] = request.outputs[1];
        threeOutputs[2] = request.outputs[1];
        request.outputs = threeOutputs;
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);

        (request, balance, ranges, signature) = transferParts("TRANSFER_PARTIAL");
        PoolTypes.RangeProofV3[] memory oneProof = new PoolTypes.RangeProofV3[](1);
        oneProof[0] = ranges[0];
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, oneProof, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);
    }

    function test_rejectsNoncanonicalOutputPoints() public {
        Pool pool = deploy();
        (PoolTypes.OperationRequest memory request, PoolTypes.BalanceProof memory balance, bytes memory signature) =
            depositParts();
        request.outputs[0].Cx = type(uint256).max;
        (bool ok, bytes memory response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);
        request.outputs[0].Cx = 1;
        request.outputs[0].Cy = 1;
        (ok, response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidRequest.selector);
    }

    function test_absentAndWrongOwnerInput() public {
        Pool pool = deploy();
        (
            PoolTypes.OperationRequest memory request,
            PoolTypes.BalanceProof memory balance,
            PoolTypes.RangeProofV3[] memory ranges,
            bytes memory signature
        ) = transferParts("TRANSFER_FULL");
        (bool ok, bytes memory response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InputNotFound.selector);

        (ok,) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(ok, "setup deposit failed");
        bytes32 inputSlot = keccak256(abi.encode(PoolVectors.outputId("DEPOSIT_TEN", 0), uint256(0)));
        vm.store(address(pool), inputSlot, bytes32(uint256(uint160(address(0xBEEF)))));
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InputOwnerMismatch.selector);
    }

    function test_seededOutputIdCollision() public {
        Pool pool = deploy();
        bytes32 outputSlot =
            bytes32(uint256(keccak256(abi.encode(PoolVectors.outputId("DEPOSIT_TEN", 0), uint256(0)))) + 3);
        vm.store(address(pool), outputSlot, bytes32(uint256(1)));
        (bool ok, bytes memory response) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        assertError(ok, response, IPool.OutputIdCollision.selector);
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

    function test_validShapeFieldMutationsFailOwnerAuthorization() public {
        Pool pool = deploy();
        (PoolTypes.OperationRequest memory request, PoolTypes.BalanceProof memory balance, bytes memory signature) =
            depositParts();
        request.d = 9;
        (bool ok, bytes memory response) =
            address(pool).call{value: 9}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        (request, balance, signature) = depositParts();
        request.salt = bytes32(uint256(0x1234));
        (ok, response) =
            address(pool).call{value: 10}(abi.encodeWithSelector(IPool.deposit.selector, request, balance, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);

        (ok,) = address(pool).call{value: 10}(PoolVectors.calldataFor("DEPOSIT_TEN"));
        require(ok, "deposit ten setup failed");
        (ok,) = address(pool).call{value: 2}(PoolVectors.calldataFor("DEPOSIT_TWO"));
        require(ok, "deposit two setup failed");
        PoolTypes.RangeProofV3[] memory ranges;
        (request, balance, ranges, signature) = transferParts("TRANSFER_FULL");
        request.inputIds[0] = PoolVectors.outputId("DEPOSIT_TWO", 0);
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        (request, balance, ranges, signature) = transferParts("TRANSFER_FULL");
        request.outputs[0].Cx = 0;
        request.outputs[0].Cy = 0;
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        (request, balance, ranges, signature) = transferParts("TRANSFER_FULL");
        request.outputs[0].packet[0] = bytes1(uint8(request.outputs[0].packet[0]) ^ 1);
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.transfer.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        (request, balance, ranges, signature) = transferParts("WITHDRAW_FULL");
        request.destination = address(this);
        (ok, response) =
            address(pool).call(abi.encodeWithSelector(IPool.withdraw.selector, request, balance, ranges, signature));
        assertError(ok, response, IPool.InvalidAuthorization.selector);
        require(!pool.isOperationExecuted(PoolVectors.operationId("TRANSFER_FULL")), "mutated operation executed");
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
