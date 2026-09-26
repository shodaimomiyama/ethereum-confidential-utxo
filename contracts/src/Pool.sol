// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IPool} from "./IPool.sol";
import {PoolTypes} from "./PoolTypes.sol";
import {PoolBinding} from "./PoolBinding.sol";
import {Bn254} from "./verifier/Bn254.sol";

contract Pool is IPool {
    uint256 internal constant M = 1 << 64;
    uint256 internal constant W = 1 << 65;
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant SECP256K1_HALF_N = SECP256K1_N / 2;
    uint256 internal constant HX = 12730586376239396577779996276718232087903100639305218386364088504561595411059;
    uint256 internal constant HY = 11546560963110481742356578822308548249278318971213841271481263934160486303484;

    struct UtxoRecord {
        address owner;
        uint256 Cx;
        uint256 Cy;
        uint8 status;
    }

    address public immutable verifier;
    mapping(bytes32 => UtxoRecord) internal utxos;
    mapping(bytes32 => bool) internal executedOperations;
    uint256 internal accountedLiability;
    bool internal operationInProgress;

    constructor(address fixedVerifier) {
        if (fixedVerifier == address(0) || fixedVerifier.code.length == 0) revert InvalidRequest();
        verifier = fixedVerifier;
    }

    modifier enter() {
        if (operationInProgress) revert ReentrantOperation();
        operationInProgress = true;
        _;
        operationInProgress = false;
    }

    receive() external payable {}

    function getUtxo(bytes32 id) external view returns (uint8 status, address owner, uint256 Cx, uint256 Cy) {
        UtxoRecord storage record = utxos[id];
        return (record.status, record.owner, record.Cx, record.Cy);
    }

    function isOperationExecuted(bytes32 id) external view returns (bool) {
        return executedOperations[id];
    }

    function getAccounting() external view returns (uint256 actualBalance, uint256 liability, uint256 unaccountedEth) {
        actualBalance = address(this).balance;
        liability = accountedLiability;
        if (actualBalance < liability) revert AccountingInvariantViolation();
        unaccountedEth = actualBalance - liability;
    }

    function deposit(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        bytes calldata signature
    ) external payable enter {
        _execute(request, balanceProof, new PoolTypes.RangeProofV3[](0), signature, 0);
    }

    function transfer(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        PoolTypes.RangeProofV3[] calldata rangeProofs,
        bytes calldata signature
    ) external enter {
        _execute(request, balanceProof, rangeProofs, signature, 1);
    }

    function withdraw(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        PoolTypes.RangeProofV3[] calldata rangeProofs,
        bytes calldata signature
    ) external enter {
        _execute(request, balanceProof, rangeProofs, signature, 2);
    }

    function _execute(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        PoolTypes.RangeProofV3[] memory rangeProofs,
        bytes calldata signature,
        uint8 expectedKind
    ) internal {
        _validateShape(request, expectedKind, rangeProofs.length);
        bytes32 id = PoolBinding.operationId(request, block.chainid, address(this));
        if (executedOperations[id]) revert OperationAlreadyExecuted(id);
        bytes32[] memory outputIds = new bytes32[](request.outputs.length);
        for (uint256 i; i < outputIds.length; ++i) {
            outputIds[i] = PoolBinding.outputId(id, i);
            for (uint256 j; j < i; ++j) {
                if (outputIds[i] == outputIds[j]) revert OutputIdCollision(outputIds[i]);
            }
            if (utxos[outputIds[i]].status != 0) revert OutputIdCollision(outputIds[i]);
        }
        for (uint256 i; i < request.inputIds.length; ++i) {
            bytes32 inputId = request.inputIds[i];
            UtxoRecord storage record = utxos[inputId];
            if (record.status == 0) revert InputNotFound(inputId);
            if (record.status == 2) revert InputAlreadySpent(inputId);
            if (record.owner != request.owner) revert InputOwnerMismatch(inputId);
        }
        _checkAuthorization(id, request.owner, signature);
        _verifyProofs(request, balanceProof, rangeProofs, id);
        _commit(request, id, outputIds);
    }

    function _verifyProofs(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        PoolTypes.RangeProofV3[] memory rangeProofs,
        bytes32 id
    ) internal view {
        Bn254.Point memory x;
        for (uint256 i; i < request.inputIds.length; ++i) {
            UtxoRecord storage record = utxos[request.inputIds[i]];
            (bool ok, Bn254.Point memory sum) = _add(x, Bn254.Point(record.Cx, record.Cy));
            if (!ok) revert InvalidBalanceProof();
            x = sum;
        }
        if (request.d != 0) {
            (bool ok, Bn254.Point memory sum) = _add(x, _mulH(request.d));
            if (!ok) revert InvalidBalanceProof();
            x = sum;
        }
        for (uint256 i; i < request.outputs.length; ++i) {
            Bn254.Point memory outputPoint = Bn254.Point(request.outputs[i].Cx, request.outputs[i].Cy);
            (bool ok, Bn254.Point memory sum) = _add(x, _neg(outputPoint));
            if (!ok) revert InvalidBalanceProof();
            x = sum;
        }
        if (request.w != 0) {
            (bool ok, Bn254.Point memory sum) = _add(x, _neg(_mulH(request.w)));
            if (!ok) revert InvalidBalanceProof();
            x = sum;
        }
        if (!_accepted(
                abi.encodeWithSignature(
                    "verifyBalance(bytes32,uint256,uint256,uint256,uint256,uint256)",
                    id,
                    x.x,
                    x.y,
                    balanceProof.Rx,
                    balanceProof.Ry,
                    balanceProof.s
                )
            )) revert InvalidBalanceProof();
        for (uint256 i; i < rangeProofs.length; ++i) {
            PoolTypes.RangeProofV3 memory proof = rangeProofs[i];
            Bn254.Point memory point = Bn254.Point(request.outputs[i].Cx, request.outputs[i].Cy);
            (bool ok, Bn254.Point memory rangePoint) = _add(point, _neg(Bn254.Point(HX, HY)));
            if (
                !ok || rangePoint.x != proof.coords[0] || rangePoint.y != proof.coords[1] || proof.ls.length != 12
                    || proof.rs.length != 12
            ) revert InvalidRangeProof(i);
            if (!_accepted(
                    abi.encodeWithSignature(
                        "verify(bytes32,uint256,uint256[10],uint256[5],uint256[],uint256[])",
                        id,
                        i,
                        proof.coords,
                        proof.scalars,
                        proof.ls,
                        proof.rs
                    )
                )) revert InvalidRangeProof(i);
        }
    }

    function _commit(PoolTypes.OperationRequest calldata request, bytes32 id, bytes32[] memory outputIds) internal {
        for (uint256 i; i < request.inputIds.length; ++i) {
            utxos[request.inputIds[i]].status = 2;
        }
        for (uint256 i; i < outputIds.length; ++i) {
            PoolTypes.Output calldata output = request.outputs[i];
            utxos[outputIds[i]] = UtxoRecord(output.owner, output.Cx, output.Cy, 1);
        }
        executedOperations[id] = true;
        if (request.d != 0) {
            if (accountedLiability > type(uint256).max - request.d) revert AccountingInvariantViolation();
            accountedLiability += request.d;
        }
        if (request.w != 0) {
            if (accountedLiability < request.w) revert AccountingInvariantViolation();
            accountedLiability -= request.w;
            bool paid;
            address destination = request.destination;
            uint256 amount = request.w;
            assembly { paid := call(gas(), destination, amount, 0, 0, 0, 0) }
            if (!paid) revert WithdrawalFailed(destination, amount);
        }
        _emitEvents(request, id, outputIds);
    }

    function _emitEvents(PoolTypes.OperationRequest calldata request, bytes32 id, bytes32[] memory outputIds) internal {
        for (uint256 i; i < request.inputIds.length; ++i) {
            emit InputConsumed(request.inputIds[i], id);
        }
        for (uint256 i; i < outputIds.length; ++i) {
            PoolTypes.Output calldata output = request.outputs[i];
            emit OutputCreated(
                output.owner, outputIds[i], id, i, output.Cx, output.Cy, output.receiptFormat, output.packet
            );
        }
        emit OperationSucceeded(
            id,
            request.kind,
            request.owner,
            request.inputIds,
            outputIds,
            request.d,
            request.w,
            request.destination,
            request.salt
        );
    }

    function _validateShape(PoolTypes.OperationRequest calldata request, uint8 kind, uint256 proofCount) internal view {
        if (request.kind != kind || request.owner == address(0)) revert InvalidRequest();
        uint256 inputCount = request.inputIds.length;
        uint256 outputCount = request.outputs.length;
        if (kind == 0) {
            if (
                inputCount != 0 || outputCount != 1 || proofCount != 0 || request.w != 0
                    || request.destination != address(0) || request.outputs[0].owner != request.owner
            ) revert InvalidRequest();
            if (request.d == 0 || request.d > M) revert PublicAmountOutOfRange();
        } else if (kind == 1) {
            if (
                inputCount < 1 || inputCount > 2 || outputCount < 1 || outputCount > 2 || proofCount != outputCount
                    || request.d != 0 || request.w != 0 || request.destination != address(0)
            ) revert InvalidRequest();
            if (outputCount == 2 && request.outputs[1].owner != request.owner) revert InvalidRequest();
        } else {
            if (
                inputCount < 1 || inputCount > 2 || outputCount > 1 || proofCount != outputCount || request.d != 0
                    || request.destination == address(0)
            ) revert InvalidRequest();
            if (request.w == 0 || request.w > W) revert PublicAmountOutOfRange();
            if (outputCount == 1 && request.outputs[0].owner != request.owner) revert InvalidRequest();
        }
        if (msg.value != request.d) revert MsgValueMismatch(request.d, msg.value);
        for (uint256 i; i < inputCount; ++i) {
            if (i != 0 && request.inputIds[i] <= request.inputIds[i - 1]) {
                if (request.inputIds[i] == request.inputIds[i - 1]) revert DuplicateInput(request.inputIds[i]);
                revert InvalidRequest();
            }
        }
        for (uint256 i; i < outputCount; ++i) {
            PoolTypes.Output calldata output = request.outputs[i];
            if (
                output.owner == address(0) || output.receiptFormat != 1 || output.packet.length != 112
                    || !Bn254.isAllowedPoint(Bn254.Point(output.Cx, output.Cy), true)
            ) revert InvalidRequest();
        }
    }

    function _checkAuthorization(bytes32 id, address owner, bytes calldata signature) internal view {
        if (signature.length != 65) revert InvalidAuthorization();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (
            uint256(r) == 0 || uint256(r) >= SECP256K1_N || uint256(s) == 0 || uint256(s) > SECP256K1_HALF_N
                || (v != 27 && v != 28)
        ) revert InvalidAuthorization();
        bytes32 digest = PoolBinding.authorizationDigest(id, owner, block.chainid, address(this));
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != owner) revert InvalidAuthorization();
    }

    function _accepted(bytes memory callData) internal view returns (bool accepted) {
        address target = verifier;
        assembly {
            let ptr := mload(0x40)
            let ok := staticcall(gas(), target, add(callData, 32), mload(callData), ptr, 32)
            accepted := and(and(ok, eq(returndatasize(), 32)), eq(mload(ptr), 1))
        }
    }

    function _add(Bn254.Point memory first, Bn254.Point memory second)
        internal
        view
        returns (bool ok, Bn254.Point memory result)
    {
        if (!Bn254.isAllowedPoint(first, true) || !Bn254.isAllowedPoint(second, true)) return (false, result);
        uint256[4] memory input = [first.x, first.y, second.x, second.y];
        assembly {
            ok := staticcall(gas(), 6, input, 128, result, 64)
            ok := and(ok, eq(returndatasize(), 64))
        }
        if (!ok || !Bn254.isAllowedPoint(result, true)) return (false, result);
    }

    function _neg(Bn254.Point memory point) internal pure returns (Bn254.Point memory) {
        if (point.x == 0 && point.y == 0) return point;
        return Bn254.Point(point.x, point.y == 0 ? 0 : Bn254.P - point.y);
    }

    function _mulH(uint256 scalar) internal view returns (Bn254.Point memory result) {
        if (scalar >= Bn254.Q) revert InvalidBalanceProof();
        uint256[3] memory input = [HX, HY, scalar];
        bool ok;
        assembly {
            ok := staticcall(gas(), 7, input, 96, result, 64)
            ok := and(ok, eq(returndatasize(), 64))
        }
        if (!ok || !Bn254.isAllowedPoint(result, true)) revert InvalidBalanceProof();
    }
}
