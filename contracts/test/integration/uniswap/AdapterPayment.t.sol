// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {UniswapPaymentAdapter} from "../../../src/integration/uniswap/UniswapPaymentAdapter.sol";
import {PoolTypes} from "../../../src/PoolTypes.sol";
import {PoolBinding} from "../../../src/PoolBinding.sol";
import {ConfigCode, ConfigFactory, ConfigPair} from "./AdapterConfiguration.t.sol";

interface VmPayment {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function deal(address target, uint256 value) external;
    function prank(address sender) external;
}

contract PaymentToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

contract PaymentPool {
    uint8 public mode;

    function setMode(uint8 value) external {
        mode = value;
    }

    function withdraw(
        PoolTypes.OperationRequest calldata request,
        PoolTypes.BalanceProof calldata,
        PoolTypes.RangeProofV3[] calldata,
        bytes calldata
    ) external {
        if (mode == 5) revert("pool rejected");
        if (mode == 1) return;
        uint256 amount = mode == 2 ? request.w - 1 : mode == 3 ? request.w + 1 : request.w;
        (bool paid,) = msg.sender.call{value: amount}("");
        require(paid, "pool payment failed");
        if (mode == 4) {
            (paid,) = msg.sender.call{value: request.w}("");
            require(paid, "second receipt failed");
        }
    }

    receive() external payable {}
}

contract PaymentRouter {
    address public factory;
    address public WETH;
    PaymentToken public token;
    uint256 public outputAmount = 7;
    uint8 public mode;

    constructor(address fixedFactory, address fixedWeth, PaymentToken fixedToken) {
        factory = fixedFactory;
        WETH = fixedWeth;
        token = fixedToken;
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function swapExactETHForTokens(uint256 minimum, address[] calldata path, address recipient, uint256)
        external
        payable
        returns (uint256[] memory amounts)
    {
        require(path.length == 2 && path[0] == WETH && path[1] == address(token), "wrong path");
        require(outputAmount >= minimum, "minimum not met");
        if (mode == 5) revert("router rejected");
        token.mint(recipient, mode == 4 ? outputAmount - 1 : outputAmount);
        amounts = new uint256[](mode == 1 ? 1 : 2);
        amounts[0] = mode == 2 ? msg.value - 1 : msg.value;
        if (amounts.length == 2) amounts[1] = mode == 3 ? outputAmount + 1 : outputAmount;
    }
}

contract PaymentRecipient {}

contract AdapterPaymentTest {
    VmPayment private constant vm = VmPayment(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant OWNER_KEY = 0x12345;

    struct Fixture {
        UniswapPaymentAdapter adapter;
        PaymentPool pool;
        PaymentRouter router;
        PaymentToken token;
    }

    function _deploy() private returns (Fixture memory fixture) {
        fixture.pool = new PaymentPool();
        ConfigCode weth = new ConfigCode();
        fixture.token = new PaymentToken();
        ConfigFactory factory = new ConfigFactory(address(0));
        (address first, address second) = address(weth) < address(fixture.token)
            ? (address(weth), address(fixture.token))
            : (address(fixture.token), address(weth));
        ConfigPair pair = new ConfigPair(address(factory), first, second);
        factory.setPair(address(pair));
        fixture.router = new PaymentRouter(address(factory), address(weth), fixture.token);
        fixture.adapter = new UniswapPaymentAdapter(
            address(fixture.pool),
            address(fixture.router),
            address(factory),
            address(weth),
            address(fixture.token),
            address(pair)
        );
        vm.deal(address(fixture.pool), 100);
    }

    function _pay(Fixture memory fixture, address recipient) private returns (bytes32 paymentId, uint256 output) {
        address owner = vm.addr(OWNER_KEY);
        PoolTypes.OperationRequest memory request;
        request.kind = 2;
        request.owner = owner;
        request.salt = bytes32(uint256(1));
        request.inputIds = new bytes32[](1);
        request.inputIds[0] = bytes32(uint256(2));
        request.outputs = new PoolTypes.Output[](1);
        request.outputs[0].owner = owner;
        request.w = 3;
        request.destination = address(fixture.adapter);
        PoolTypes.RangeProofV3[] memory ranges = new PoolTypes.RangeProofV3[](1);
        UniswapPaymentAdapter.PaymentTerms memory terms = UniswapPaymentAdapter.PaymentTerms({
            operationId: _operationId(fixture.adapter, request),
            owner: owner,
            ethAmount: 3,
            token: address(fixture.token),
            minAmountOut: 2,
            recipient: recipient,
            deadline: type(uint64).max
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, fixture.adapter.paymentDigest(terms));
        vm.prank(address(0xBEEF));
        return fixture.adapter
            .pay(
                request,
                PoolTypes.BalanceProof(0, 0, 0),
                ranges,
                abi.encodePacked(r, s, v),
                terms,
                abi.encodePacked(r, s, v)
            );
    }

    function _operationId(UniswapPaymentAdapter adapter, PoolTypes.OperationRequest memory request)
        private
        view
        returns (bytes32)
    {
        // The adapter validates the same PoolBinding operation ID; this helper only prepares test calldata.
        return this.operationId(request, adapter.pool());
    }

    function operationId(PoolTypes.OperationRequest calldata request, address pool) external view returns (bytes32) {
        return PoolBinding.operationId(request, block.chainid, pool);
    }

    function test_payTransfersAllOutputAndRecordsPayment() public {
        Fixture memory fixture = _deploy();
        PaymentRecipient recipient = new PaymentRecipient();
        fixture.token.mint(address(recipient), 11);
        (bytes32 paymentId, uint256 output) = _pay(fixture, address(recipient));
        require(output == 7, "wrong output");
        require(fixture.token.balanceOf(address(recipient)) == 18, "existing balance counted as output");
        require(fixture.adapter.isPaymentExecuted(paymentId), "payment not recorded");
        require(address(fixture.adapter).balance == 0, "Adapter retained ETH");
        require(fixture.token.balanceOf(address(fixture.adapter)) == 0, "Adapter retained token");
    }

    function test_directEthReceiptIsRejected() public {
        Fixture memory fixture = _deploy();
        vm.deal(address(this), 1);
        (bool accepted,) = address(fixture.adapter).call{value: 1}("");
        require(!accepted, "direct ETH accepted");
        (accepted,) = address(fixture.adapter).call(hex"deadbeef");
        require(!accepted, "fallback accepted");
        (accepted,) =
            address(fixture.adapter).call{value: 1}(abi.encodeWithSelector(UniswapPaymentAdapter.pay.selector));
        require(!accepted, "pay accepted ETH");
    }

    function invokePay(Fixture memory fixture, address recipient) external returns (bytes32, uint256) {
        return _pay(fixture, recipient);
    }

    function _rejects(Fixture memory fixture) private returns (bool) {
        try this.invokePay(fixture, address(0xCAFE)) returns (bytes32, uint256) {
            return false;
        } catch {
            return true;
        }
    }

    function test_existingEthIsNotSpent() public {
        Fixture memory fixture = _deploy();
        vm.deal(address(fixture.adapter), 17);
        _pay(fixture, address(0xCAFE));
        require(address(fixture.adapter).balance == 17, "preexisting ETH was spent");
    }

    function test_rejectsMissingWrongAndRepeatedPoolReceipts() public {
        for (uint8 mode = 1; mode <= 5; ++mode) {
            Fixture memory fixture = _deploy();
            fixture.pool.setMode(mode);
            require(_rejects(fixture), "bad Pool receipt accepted");
            require(address(fixture.adapter).balance == 0, "ETH remained");
        }
    }

    function test_rejectsSwapReturnAndDeliveryMismatch() public {
        for (uint8 mode = 1; mode <= 5; ++mode) {
            Fixture memory fixture = _deploy();
            fixture.router.setMode(mode);
            require(_rejects(fixture), "bad swap accepted");
            require(fixture.token.balanceOf(address(0xCAFE)) == 0, "delivery survived revert");
        }
    }

    receive() external payable {}
}
