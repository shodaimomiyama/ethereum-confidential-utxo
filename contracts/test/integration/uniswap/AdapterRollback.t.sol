// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {AdapterPaymentTest, PaymentPool, PaymentRouter} from "./AdapterPayment.t.sol";
import {UniswapPaymentAdapter} from "../../../src/integration/uniswap/UniswapPaymentAdapter.sol";
import {PoolTypes} from "../../../src/PoolTypes.sol";

interface VmRollback {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract AdapterRollbackTest is AdapterPaymentTest {
    VmRollback private constant vmRollback = VmRollback(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _assertUnchanged(Fixture memory fixture, bytes32 paymentId, uint256 initialPoolEth) internal view {
        require(!fixture.pool.spent(bytes32(uint256(2))), "input spent");
        require(fixture.pool.liability() == 100, "Pool liability changed");
        require(address(fixture.pool).balance == initialPoolEth, "Pool ETH changed");
        require(address(fixture.adapter).balance == 0, "Adapter ETH changed");
        require(fixture.router.swappedEth() == 0, "swap state survived");
        require(fixture.token.balanceOf(address(0xCAFE)) == 0, "recipient received dUSD");
        require(!fixture.adapter.isPaymentExecuted(paymentId), "payment recorded");
    }

    function _assertNoSuccessLogs(VmRollback.Log[] memory logs, address pool, address adapter) internal pure {
        for (uint256 i; i < logs.length; ++i) {
            require(logs[i].emitter != pool && logs[i].emitter != adapter, "failure emitted success log");
        }
    }

    function test_poolFailuresRollbackEvenWhenOuterCallerCatches() public {
        for (uint8 mode = 2; mode <= 5; ++mode) {
            Fixture memory fixture = _deploy();
            (,, UniswapPaymentAdapter.PaymentTerms memory terms,) = _paymentCall(fixture, address(0xCAFE));
            bytes32 paymentId = fixture.adapter.paymentDigest(terms);
            uint256 poolEth = address(fixture.pool).balance;
            fixture.pool.setMode(mode);
            vmRollback.recordLogs();
            require(_rejects(fixture), "Pool failure accepted");
            _assertUnchanged(fixture, paymentId, poolEth);
            _assertNoSuccessLogs(vmRollback.getRecordedLogs(), address(fixture.pool), address(fixture.adapter));
        }
    }

    function test_swapAndDeliveryFailuresRollbackEvenWhenOuterCallerCatches() public {
        for (uint8 mode = 1; mode <= 5; ++mode) {
            Fixture memory fixture = _deploy();
            (,, UniswapPaymentAdapter.PaymentTerms memory terms,) = _paymentCall(fixture, address(0xCAFE));
            bytes32 paymentId = fixture.adapter.paymentDigest(terms);
            uint256 poolEth = address(fixture.pool).balance;
            fixture.router.setMode(mode);
            vmRollback.recordLogs();
            require(_rejects(fixture), "bad swap accepted");
            _assertUnchanged(fixture, paymentId, poolEth);
            _assertNoSuccessLogs(vmRollback.getRecordedLogs(), address(fixture.pool), address(fixture.adapter));
        }
    }

    function test_failedAttemptCanRetryAndSuccessfulPaymentCannotRepeat() public {
        Fixture memory fixture = _deploy();
        fixture.router.setMode(4);
        require(_rejects(fixture), "bad delivery accepted");
        require(!fixture.pool.spent(bytes32(uint256(2))), "failed input spent");
        fixture.router.setMode(0);
        (bytes32 paymentId,) = _pay(fixture, address(0xCAFE));
        require(fixture.adapter.isPaymentExecuted(paymentId), "retry not recorded");
        require(fixture.pool.spent(bytes32(uint256(2))), "successful input unspent");
        require(_rejects(fixture), "duplicate payment accepted");
        require(fixture.pool.liability() == 97, "duplicate changed liability");
    }

    function test_reentryIsRejectedWhileOuterPaymentCanSucceed() public {
        Fixture memory fixture = _deploy();
        (
            PoolTypes.OperationRequest memory request,
            PoolTypes.RangeProofV3[] memory ranges,
            UniswapPaymentAdapter.PaymentTerms memory terms,
            bytes memory signature
        ) = _paymentCall(fixture, address(0xCAFE));
        bytes memory inner = abi.encodeCall(
            UniswapPaymentAdapter.pay, (request, PoolTypes.BalanceProof(0, 0, 0), ranges, signature, terms, signature)
        );
        fixture.router.setReentry(address(fixture.adapter), inner, false);
        (bytes32 paymentId,) = _pay(fixture, address(0xCAFE));
        require(
            fixture.router.lastReentrySelector() == UniswapPaymentAdapter.ReentrantPayment.selector,
            "inner pay rejected for wrong reason"
        );
        require(fixture.adapter.isPaymentExecuted(paymentId), "outer payment failed");
        require(fixture.pool.liability() == 97, "inner changed Pool liability");
    }

    function test_propagatedReentryRollsBackOuterPayment() public {
        Fixture memory fixture = _deploy();
        (
            PoolTypes.OperationRequest memory request,
            PoolTypes.RangeProofV3[] memory ranges,
            UniswapPaymentAdapter.PaymentTerms memory terms,
            bytes memory signature
        ) = _paymentCall(fixture, address(0xCAFE));
        bytes memory inner = abi.encodeCall(
            UniswapPaymentAdapter.pay, (request, PoolTypes.BalanceProof(0, 0, 0), ranges, signature, terms, signature)
        );
        fixture.router.setReentry(address(fixture.adapter), inner, true);
        require(_rejects(fixture), "propagated reentry accepted");
        _assertUnchanged(fixture, fixture.adapter.paymentDigest(terms), 100);
    }
}
