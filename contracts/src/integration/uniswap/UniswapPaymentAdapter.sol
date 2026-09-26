// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PoolTypes} from "../../PoolTypes.sol";
import {PoolBinding} from "../../PoolBinding.sol";

interface IRouterConfiguration {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

interface IFactoryConfiguration {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IPairConfiguration {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract UniswapPaymentAdapter {
    error InvalidConfiguration();
    error InvalidPayment();
    error InvalidPaymentSignature();
    error UnsupportedToken();
    error UnsupportedRecipient();
    error PaymentExpired(uint64 deadline);
    error PaymentAlreadyExecuted(bytes32 paymentId);
    error UnexpectedEthReceipt();
    error ReentrantPayment();
    error SwapAccountingMismatch();
    error DeliveryMismatch();

    bytes32 internal constant DOMAIN_TYPE =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PAYMENT_TYPE = keccak256(
        "PaymentAuthorization(bytes32 operationId,address owner,uint256 ethAmount,address token,uint256 minAmountOut,address recipient,uint64 deadline)"
    );
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant SECP256K1_HALF_N = SECP256K1_N / 2;

    struct PaymentTerms {
        bytes32 operationId;
        address owner;
        uint256 ethAmount;
        address token;
        uint256 minAmountOut;
        address recipient;
        uint64 deadline;
    }

    address public immutable pool;
    address public immutable router02;
    address public immutable factory;
    address public immutable weth;
    address public immutable dUSD;
    address public immutable pair;

    constructor(address pool_, address router02_, address factory_, address weth_, address dUSD_, address pair_) {
        if (
            pool_.code.length == 0 || router02_.code.length == 0 || factory_.code.length == 0 || weth_.code.length == 0
                || dUSD_.code.length == 0 || pair_.code.length == 0
        ) revert InvalidConfiguration();

        address first = weth_ < dUSD_ ? weth_ : dUSD_;
        address second = weth_ < dUSD_ ? dUSD_ : weth_;
        if (
            IRouterConfiguration(router02_).factory() != factory_ || IRouterConfiguration(router02_).WETH() != weth_
                || IFactoryConfiguration(factory_).getPair(weth_, dUSD_) != pair_
                || IPairConfiguration(pair_).factory() != factory_ || IPairConfiguration(pair_).token0() != first
                || IPairConfiguration(pair_).token1() != second
        ) revert InvalidConfiguration();

        pool = pool_;
        router02 = router02_;
        factory = factory_;
        weth = weth_;
        dUSD = dUSD_;
        pair = pair_;
    }

    function paymentDigest(PaymentTerms calldata terms) external view returns (bytes32) {
        return _paymentDigest(terms);
    }

    function _paymentDigest(PaymentTerms calldata terms) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPE,
                keccak256("Ethereum Confidential UTXO Uniswap Payment"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        bytes32 authorization = keccak256(
            abi.encode(
                PAYMENT_TYPE,
                terms.operationId,
                terms.owner,
                terms.ethAmount,
                terms.token,
                terms.minAmountOut,
                terms.recipient,
                terms.deadline
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, authorization));
    }

    function _validatePayment(
        PoolTypes.OperationRequest calldata withdrawal,
        PoolTypes.RangeProofV3[] calldata rangeProofs,
        PaymentTerms calldata terms,
        bytes calldata paymentSignature
    ) internal view returns (bytes32 operationId, bytes32 paymentId) {
        if (
            withdrawal.kind != 2 || withdrawal.d != 0 || withdrawal.w == 0 || withdrawal.inputIds.length != 1
                || withdrawal.outputs.length != 1 || rangeProofs.length != 1 || terms.owner == address(0)
                || withdrawal.owner != terms.owner || withdrawal.outputs[0].owner != terms.owner
                || withdrawal.destination != address(this) || terms.ethAmount != withdrawal.w
        ) revert InvalidPayment();
        operationId = PoolBinding.operationId(withdrawal, block.chainid, pool);
        if (terms.operationId != operationId) revert InvalidPayment();
        if (terms.token != dUSD) revert UnsupportedToken();
        if (
            terms.recipient == address(0) || terms.recipient == address(this) || terms.recipient == pool
                || terms.recipient == router02 || terms.recipient == factory || terms.recipient == weth
                || terms.recipient == dUSD || terms.recipient == pair
        ) revert UnsupportedRecipient();
        if (terms.minAmountOut == 0 || terms.deadline == 0) revert InvalidPayment();
        if (block.timestamp > terms.deadline) revert PaymentExpired(terms.deadline);

        paymentId = _paymentDigest(terms);
        if (paymentSignature.length != 65) revert InvalidPaymentSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(paymentSignature.offset)
            s := calldataload(add(paymentSignature.offset, 32))
            v := byte(0, calldataload(add(paymentSignature.offset, 64)))
        }
        if (
            uint256(r) == 0 || uint256(r) >= SECP256K1_N || uint256(s) == 0 || uint256(s) > SECP256K1_HALF_N
                || (v != 27 && v != 28)
        ) revert InvalidPaymentSignature();
        address signer = ecrecover(paymentId, v, r, s);
        if (signer == address(0) || signer != terms.owner) revert InvalidPaymentSignature();
    }
}
