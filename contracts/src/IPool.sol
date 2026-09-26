// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PoolTypes} from "./PoolTypes.sol";

interface IPool {
    event OperationSucceeded(
        bytes32 indexed operationId,
        uint8 kind,
        address indexed owner,
        bytes32[] inputIds,
        bytes32[] outputIds,
        uint256 d,
        uint256 w,
        address destination,
        bytes32 salt
    );
    event OutputCreated(
        address indexed owner,
        bytes32 indexed utxoId,
        bytes32 indexed operationId,
        uint256 outputIndex,
        uint256 Cx,
        uint256 Cy,
        uint8 receiptFormat,
        bytes packet
    );
    event InputConsumed(bytes32 indexed inputId, bytes32 indexed operationId);

    error InvalidRequest();
    error PublicAmountOutOfRange();
    error MsgValueMismatch(uint256 expected, uint256 actual);
    error ReentrantOperation();
    error InputNotFound(bytes32 inputId);
    error InputAlreadySpent(bytes32 inputId);
    error DuplicateInput(bytes32 inputId);
    error InputOwnerMismatch(bytes32 inputId);
    error OperationAlreadyExecuted(bytes32 operationId);
    error OutputIdCollision(bytes32 outputId);
    error InvalidAuthorization();
    error InvalidBalanceProof();
    error InvalidRangeProof(uint256 outputIndex);
    error WithdrawalFailed(address destination, uint256 amount);
    error AccountingInvariantViolation();

    function deposit(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        bytes calldata signature
    ) external payable;
    function transfer(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        PoolTypes.RangeProofV3[] calldata rangeProofs,
        bytes calldata signature
    ) external;
    function withdraw(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata balanceProof,
        PoolTypes.RangeProofV3[] calldata rangeProofs,
        bytes calldata signature
    ) external;
    function getUtxo(bytes32 utxoId) external view returns (uint8 status, address owner, uint256 Cx, uint256 Cy);
    function isOperationExecuted(bytes32 operationId) external view returns (bool executed);
    function getAccounting()
        external
        view
        returns (uint256 actualBalance, uint256 accountedLiability, uint256 unaccountedEth);
}
