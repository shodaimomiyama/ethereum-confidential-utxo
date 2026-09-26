// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {UniswapPaymentAdapter} from "../../../src/integration/uniswap/UniswapPaymentAdapter.sol";
import {PoolTypes} from "../../../src/PoolTypes.sol";
import {PoolBinding} from "../../../src/PoolBinding.sol";
import {ConfigCode, ConfigRouter, ConfigFactory, ConfigPair} from "./AdapterConfiguration.t.sol";

interface VmAuthorization {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function chainId(uint256 value) external;
    function warp(uint256 value) external;
    function etch(address target, bytes calldata code) external;
}

contract AdapterAuthorizationHarness is UniswapPaymentAdapter {
    constructor(address pool_, address router_, address factory_, address weth_, address dUSD_, address pair_)
        UniswapPaymentAdapter(pool_, router_, factory_, weth_, dUSD_, pair_)
    {}

    function operationId(PoolTypes.OperationRequest calldata request) external view returns (bytes32) {
        return PoolBinding.operationId(request, block.chainid, pool);
    }

    function operationIdFor(PoolTypes.OperationRequest calldata request, address fixedPool)
        external
        view
        returns (bytes32)
    {
        return PoolBinding.operationId(request, block.chainid, fixedPool);
    }

    function validate(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.RangeProofV3[] calldata ranges,
        PaymentTerms calldata terms,
        bytes calldata signature
    ) external view returns (bytes32, bytes32) {
        return _validatePayment(request, ranges, terms, signature);
    }
}

contract AdapterAuthorizationTest {
    VmAuthorization private constant vm = VmAuthorization(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0x12345;

    function _deploy() private returns (AdapterAuthorizationHarness adapter) {
        ConfigCode pool = new ConfigCode();
        ConfigCode weth = new ConfigCode();
        ConfigCode dusd = new ConfigCode();
        ConfigFactory factory = new ConfigFactory(address(0));
        (address first, address second) =
            address(weth) < address(dusd) ? (address(weth), address(dusd)) : (address(dusd), address(weth));
        ConfigPair pair = new ConfigPair(address(factory), first, second);
        factory.setPair(address(pair));
        ConfigRouter router = new ConfigRouter(address(factory), address(weth));
        adapter = new AdapterAuthorizationHarness(
            address(pool), address(router), address(factory), address(weth), address(dusd), address(pair)
        );
        vm.chainId(31337);
        vm.warp(1000);
    }

    function _request(address owner, address destination)
        private
        pure
        returns (PoolTypes.OperationRequest memory request)
    {
        request.kind = 2;
        request.owner = owner;
        request.salt = bytes32(uint256(33));
        request.inputIds = new bytes32[](1);
        request.inputIds[0] = bytes32(uint256(44));
        request.outputs = new PoolTypes.Output[](1);
        request.outputs[0].owner = owner;
        request.outputs[0].receiptFormat = 1;
        request.d = 0;
        request.w = 3;
        request.destination = destination;
    }

    function _ranges() private pure returns (PoolTypes.RangeProofV3[] memory ranges) {
        ranges = new PoolTypes.RangeProofV3[](1);
    }

    function _terms(AdapterAuthorizationHarness adapter, PoolTypes.OperationRequest memory request)
        private
        view
        returns (UniswapPaymentAdapter.PaymentTerms memory terms)
    {
        terms = UniswapPaymentAdapter.PaymentTerms({
            operationId: adapter.operationId(request),
            owner: request.owner,
            ethAmount: request.w,
            token: adapter.dUSD(),
            minAmountOut: 2,
            recipient: address(0xABCD),
            deadline: 1000
        });
    }

    function _sign(AdapterAuthorizationHarness adapter, UniswapPaymentAdapter.PaymentTerms memory terms)
        private
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, adapter.paymentDigest(terms));
        return abi.encodePacked(r, s, v);
    }

    function _rejects(
        AdapterAuthorizationHarness adapter,
        PoolTypes.OperationRequest memory request,
        PoolTypes.RangeProofV3[] memory ranges,
        UniswapPaymentAdapter.PaymentTerms memory terms,
        bytes memory signature
    ) private view returns (bool) {
        try adapter.validate(request, ranges, terms, signature) returns (bytes32, bytes32) {
            return false;
        } catch {
            return true;
        }
    }

    function _revertSelector(
        AdapterAuthorizationHarness adapter,
        PoolTypes.OperationRequest memory request,
        UniswapPaymentAdapter.PaymentTerms memory terms,
        bytes memory signature
    ) private view returns (bytes4 selector) {
        (bool accepted, bytes memory result) = address(adapter)
            .staticcall(abi.encodeCall(adapter.validate, (request, _ranges(), terms, signature)));
        require(!accepted && result.length >= 4, "expected validation revert");
        return bytes4(result);
    }

    function test_validOwnerAuthorizationBindsOperationAndPayment() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        bytes memory signature = _sign(adapter, terms);
        (bytes32 operationId, bytes32 paymentId) = adapter.validate(request, _ranges(), terms, signature);
        require(operationId == terms.operationId, "operation not bound");
        require(paymentId == adapter.paymentDigest(terms), "payment ID not digest");
    }

    function test_eachPaymentFieldMutationInvalidatesSignature() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        bytes memory signature = _sign(adapter, terms);
        terms.ethAmount++;
        require(
            _revertSelector(adapter, request, terms, signature) == UniswapPaymentAdapter.InvalidPayment.selector,
            "amount rejected for wrong reason"
        );
        terms = _terms(adapter, request);
        terms.token = address(0xCAFE);
        require(
            _revertSelector(adapter, request, terms, signature) == UniswapPaymentAdapter.UnsupportedToken.selector,
            "token rejected for wrong reason"
        );
        terms = _terms(adapter, request);
        terms.minAmountOut++;
        require(
            _revertSelector(adapter, request, terms, signature)
                == UniswapPaymentAdapter.InvalidPaymentSignature.selector,
            "minimum rejected for wrong reason"
        );
        terms = _terms(adapter, request);
        terms.recipient = address(0xDDDD);
        require(
            _revertSelector(adapter, request, terms, signature)
                == UniswapPaymentAdapter.InvalidPaymentSignature.selector,
            "recipient rejected for wrong reason"
        );
        terms = _terms(adapter, request);
        terms.deadline++;
        require(
            _revertSelector(adapter, request, terms, signature)
                == UniswapPaymentAdapter.InvalidPaymentSignature.selector,
            "deadline rejected for wrong reason"
        );
    }

    function test_requestMutationAndDirectWithdrawalAreRejected() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        bytes memory signature = _sign(adapter, terms);
        request.destination = address(0xEEEE);
        require(_rejects(adapter, request, _ranges(), terms, signature), "direct withdrawal accepted");
        request.destination = address(adapter);
        request.inputIds[0] = bytes32(uint256(45));
        require(_rejects(adapter, request, _ranges(), terms, signature), "input substitution accepted");
        request.inputIds[0] = bytes32(uint256(44));
        request.outputs[0].Cx = 123;
        require(_rejects(adapter, request, _ranges(), terms, signature), "change substitution accepted");
    }

    function test_wrongChainAdapterAndSignatureShapeAreRejected() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        bytes memory signature = _sign(adapter, terms);
        vm.chainId(31338);
        require(_rejects(adapter, request, _ranges(), terms, signature), "wrong chain accepted");
        vm.chainId(31337);
        require(_rejects(adapter, request, _ranges(), terms, hex"00"), "short signature accepted");
        signature[64] = bytes1(uint8(29));
        require(_rejects(adapter, request, _ranges(), terms, signature), "invalid v accepted");
    }

    function test_wrongDomainAndPoolAreRejectedForOtherwiseValidTerms() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        vm.chainId(31338);
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        vm.chainId(31337);
        bytes memory wrongChainSignature = _sign(adapter, terms);
        vm.chainId(31338);
        require(
            _revertSelector(adapter, request, terms, wrongChainSignature)
                == UniswapPaymentAdapter.InvalidPaymentSignature.selector,
            "wrong EIP-712 chain domain accepted"
        );
        vm.chainId(31337);

        AdapterAuthorizationHarness other = new AdapterAuthorizationHarness(
            adapter.pool(), adapter.router02(), adapter.factory(), adapter.weth(), adapter.dUSD(), adapter.pair()
        );
        request.destination = address(other);
        terms = _terms(other, request);
        bytes memory wrongAdapterSignature = _sign(adapter, terms);
        require(
            _revertSelector(other, request, terms, wrongAdapterSignature)
                == UniswapPaymentAdapter.InvalidPaymentSignature.selector,
            "wrong EIP-712 adapter domain accepted"
        );

        ConfigCode differentPool = new ConfigCode();
        AdapterAuthorizationHarness differentPoolAdapter = new AdapterAuthorizationHarness(
            address(differentPool),
            adapter.router02(),
            adapter.factory(),
            adapter.weth(),
            adapter.dUSD(),
            adapter.pair()
        );
        request.destination = address(differentPoolAdapter);
        terms = _terms(differentPoolAdapter, request);
        terms.operationId = differentPoolAdapter.operationIdFor(request, adapter.pool());
        require(
            _revertSelector(differentPoolAdapter, request, terms, _sign(differentPoolAdapter, terms))
                == UniswapPaymentAdapter.InvalidPayment.selector,
            "different Pool operation accepted"
        );
    }

    function test_deadlineBoundaryAndForbiddenRecipient() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        bytes memory signature = _sign(adapter, terms);
        adapter.validate(request, _ranges(), terms, signature);
        vm.warp(1001);
        require(_rejects(adapter, request, _ranges(), terms, signature), "expired accepted");
        vm.warp(1000);
        terms.recipient = adapter.pool();
        signature = _sign(adapter, terms);
        require(_rejects(adapter, request, _ranges(), terms, signature), "forbidden recipient accepted");
    }

    function test_allForbiddenRecipientsAndZeroMinimum() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        address[8] memory forbidden = [
            address(0),
            address(adapter),
            adapter.pool(),
            adapter.router02(),
            adapter.factory(),
            adapter.weth(),
            adapter.dUSD(),
            adapter.pair()
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            terms.recipient = forbidden[i];
            require(_rejects(adapter, request, _ranges(), terms, _sign(adapter, terms)), "forbidden recipient accepted");
        }
        terms.recipient = address(0xABCD);
        terms.minAmountOut = 0;
        require(_rejects(adapter, request, _ranges(), terms, _sign(adapter, terms)), "zero minimum accepted");
    }

    function test_highSSignatureAndWrongOwnerAreRejected() public {
        AdapterAuthorizationHarness adapter = _deploy();
        PoolTypes.OperationRequest memory request = _request(vm.addr(OWNER_KEY), address(adapter));
        UniswapPaymentAdapter.PaymentTerms memory terms = _terms(adapter, request);
        bytes memory signature = _sign(adapter, terms);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        uint256 order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory highS = abi.encodePacked(r, bytes32(order - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        require(_rejects(adapter, request, _ranges(), terms, highS), "high-s accepted");
        terms.owner = vm.addr(OWNER_KEY + 1);
        require(_rejects(adapter, request, _ranges(), terms, signature), "wrong owner accepted");
    }

    function test_independentOperationAndPaymentVector() public {
        AdapterAuthorizationHarness implementation = _deploy();
        address fixedAdapter = 0x2222222222222222222222222222222222222222;
        vm.etch(fixedAdapter, address(implementation).code);
        AdapterAuthorizationHarness adapter = AdapterAuthorizationHarness(payable(fixedAdapter));
        address owner = 0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1;
        PoolTypes.OperationRequest memory request = _request(owner, fixedAdapter);
        request.salt = 0x2121212121212121212121212121212121212121212121212121212121212121;
        request.inputIds[0] = 0x2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c;
        bytes32 operationId = adapter.operationIdFor(request, 0x1111111111111111111111111111111111111111);
        require(
            operationId == 0xd3f5da24e3f3ed38dc05a6fe1f8493e88897d930ca9599ce9eca92f17fab966e,
            "independent operation ID differs"
        );
        UniswapPaymentAdapter.PaymentTerms memory terms = UniswapPaymentAdapter.PaymentTerms({
            operationId: operationId,
            owner: owner,
            ethAmount: 3,
            token: 0x3333333333333333333333333333333333333333,
            minAmountOut: 2,
            recipient: 0x4444444444444444444444444444444444444444,
            deadline: 1000
        });
        require(
            adapter.paymentDigest(terms) == 0x8b9a3f0c7fd79170cfe55065db21ec76966e79e251092c64f4dc6e702c3b40b6,
            "independent payment digest differs"
        );
    }
}
