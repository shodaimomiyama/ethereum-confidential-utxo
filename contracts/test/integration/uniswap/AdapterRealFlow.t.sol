// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Pool} from "../../../src/Pool.sol";
import {IPool} from "../../../src/IPool.sol";
import {PoolTypes} from "../../../src/PoolTypes.sol";
import {RangeBalanceVerifier} from "../../../src/verifier/RangeBalanceVerifier.sol";
import {VerifierVectors} from "../../fixtures/VerifierVectors.sol";
import {UniswapPaymentAdapter} from "../../../src/integration/uniswap/UniswapPaymentAdapter.sol";
import {DemoUSD} from "../../../src/integration/uniswap/DemoUSD.sol";

interface VmRealFlow {
    function readFile(string calldata path) external returns (string memory);
    function parseJson(string calldata json, string calldata key) external pure returns (bytes memory);
    function etch(address target, bytes calldata code) external;
    function deal(address target, uint256 value) external;
    function chainId(uint256 value) external;
    function warp(uint256 value) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
}

interface IFactoryReal {
    function getPair(address first, address second) external view returns (address);
}

interface IPairReal {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 timestamp);
}

interface IRouterProvision {
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

contract AdapterRealFlowTest {
    VmRealFlow private constant vm = VmRealFlow(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant FIXED_POOL = 0x1111111111111111111111111111111111111111;
    address private constant FIXED_ADAPTER = 0x2222222222222222222222222222222222222222;
    uint256 private constant OWNER_KEY = 0x0101010101010101010101010101010101010101010101010101010101010101;
    uint256 private constant DEPOSIT = 6e15;

    struct Fixture {
        Pool pool;
        UniswapPaymentAdapter adapter;
        DemoUSD token;
        address pair;
        bytes32 inputId;
    }

    struct AssetSet {
        DemoUSD token;
        address weth;
        address factory;
        address router;
        address pair;
    }

    struct PaymentCall {
        PoolTypes.OperationRequest request;
        PoolTypes.BalanceProof balance;
        PoolTypes.RangeProofV3[] ranges;
        bytes poolSignature;
        UniswapPaymentAdapter.PaymentTerms terms;
        bytes paymentSignature;
    }

    function _fixtureJson() private returns (string memory) {
        return vm.readFile("test/fixtures/uniswap-payment-calldata.json");
    }

    function _entryBytes(string memory json, string memory name, string memory field)
        private
        pure
        returns (bytes memory)
    {
        return abi.decode(vm.parseJson(json, string.concat(".", name, ".", field)), (bytes));
    }

    function _entryId(string memory json, string memory name, string memory field) private pure returns (bytes32) {
        return abi.decode(vm.parseJson(json, string.concat(".", name, ".", field)), (bytes32));
    }

    function _artifact(string memory json, string memory name) private pure returns (bytes memory) {
        return abi.decode(vm.parseJson(json, string.concat(".artifacts.", name, ".creationBytecode")), (bytes));
    }

    function _deployBytes(bytes memory creation, bytes memory arguments) private returns (address deployed) {
        bytes memory init = bytes.concat(creation, arguments);
        assembly { deployed := create(0, add(init, 32), mload(init)) }
        require(deployed.code.length != 0, "artifact deployment failed");
    }

    function _deployAssets() private returns (AssetSet memory assets) {
        string memory assetJson = vm.readFile("../packages/ethereum/generated/uniswap-v2.json");
        assets.weth = _deployBytes(_artifact(assetJson, "weth9"), "");
        assets.factory = _deployBytes(_artifact(assetJson, "factory"), abi.encode(address(this)));
        assets.router = _deployBytes(_artifact(assetJson, "router02"), abi.encode(assets.factory, assets.weth));
        assets.token = new DemoUSD(address(this));
        uint256 liquidityToken = 10_000e18;
        require(assets.token.approve(assets.router, liquidityToken), "approve failed");
        IRouterProvision(assets.router).addLiquidityETH{value: 0.1 ether}(
            address(assets.token), liquidityToken, liquidityToken, 0.1 ether, address(this), block.timestamp + 100
        );
        assets.pair = IFactoryReal(assets.factory).getPair(assets.weth, address(assets.token));
        require(assets.pair.code.length != 0, "real pair missing");
    }

    function _deployPool() private returns (Pool pool) {
        (uint256[4] memory base, uint256[128] memory gs, uint256[128] memory hs) = VerifierVectors.parameters();
        RangeBalanceVerifier verifier = new RangeBalanceVerifier(base, gs, hs);
        Pool poolSource = new Pool(address(verifier));
        vm.etch(FIXED_POOL, address(poolSource).code);
        return Pool(payable(FIXED_POOL));
    }

    function _prepare() private returns (Fixture memory fixture) {
        vm.chainId(31337);
        vm.warp(1000);
        vm.deal(address(this), 1 ether);
        AssetSet memory assets = _deployAssets();
        fixture.token = assets.token;
        fixture.pair = assets.pair;
        fixture.pool = _deployPool();
        UniswapPaymentAdapter adapterSource = new UniswapPaymentAdapter(
            FIXED_POOL, assets.router, assets.factory, assets.weth, address(assets.token), assets.pair
        );
        vm.etch(FIXED_ADAPTER, address(adapterSource).code);
        fixture.adapter = UniswapPaymentAdapter(payable(FIXED_ADAPTER));
        string memory fixtures = _fixtureJson();
        bytes memory depositData = _entryBytes(fixtures, "DEPOSIT_PAY", "calldata");
        (bool deposited,) = FIXED_POOL.call{value: DEPOSIT}(depositData);
        require(deposited, "real deposit failed");
        fixture.inputId = abi.decode(vm.parseJson(fixtures, ".DEPOSIT_PAY.outputIds[0]"), (bytes32));
        (uint8 status,,,) = fixture.pool.getUtxo(fixture.inputId);
        require(status == 1, "input not created");
    }

    function _withdrawal(string memory name)
        private
        returns (
            PoolTypes.OperationRequest memory request,
            PoolTypes.BalanceProof memory balance,
            PoolTypes.RangeProofV3[] memory ranges,
            bytes memory poolSignature
        )
    {
        bytes memory data = _entryBytes(_fixtureJson(), name, "calldata");
        bytes memory body = new bytes(data.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = data[i + 4];
        }
        return abi.decode(body, (PoolTypes.OperationRequest, PoolTypes.BalanceProof, PoolTypes.RangeProofV3[], bytes));
    }

    function _paymentCall(Fixture memory fixture, string memory name, uint256 minAmountOut)
        private
        returns (PaymentCall memory payment, bytes32 paymentId, bytes32 outputId)
    {
        (payment.request, payment.balance, payment.ranges, payment.poolSignature) = _withdrawal(name);
        require(payment.request.destination == FIXED_ADAPTER, "fixture destination differs");
        string memory json = _fixtureJson();
        outputId = abi.decode(vm.parseJson(json, string.concat(".", name, ".outputIds[0]")), (bytes32));
        payment.terms = UniswapPaymentAdapter.PaymentTerms({
            operationId: _entryId(json, name, "operationId"),
            owner: payment.request.owner,
            ethAmount: payment.request.w,
            token: address(fixture.token),
            minAmountOut: minAmountOut,
            recipient: address(0xCAFE),
            deadline: uint64(block.timestamp + 100)
        });
        paymentId = fixture.adapter.paymentDigest(payment.terms);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, paymentId);
        payment.paymentSignature = abi.encodePacked(r, s, v);
    }

    function _encodedPayment(PaymentCall memory payment) private pure returns (bytes memory) {
        return abi.encodeCall(
            UniswapPaymentAdapter.pay,
            (
                payment.request,
                payment.balance,
                payment.ranges,
                payment.poolSignature,
                payment.terms,
                payment.paymentSignature
            )
        );
    }

    function _pay(Fixture memory fixture, string memory name, uint256 minAmountOut)
        private
        returns (bool ok, bytes memory result, bytes32 paymentId, bytes32 outputId)
    {
        (PaymentCall memory payment, bytes32 id, bytes32 remainder) = _paymentCall(fixture, name, minAmountOut);
        paymentId = id;
        outputId = remainder;
        vm.prank(address(0xBEEF));
        (ok, result) = address(fixture.adapter).call(_encodedPayment(payment));
    }

    function test_realPaymentConsumesInputAndDeliversAllTokens() public {
        Fixture memory fixture = _prepare();
        (uint112 reserve0Before, uint112 reserve1Before,) = IPairReal(fixture.pair).getReserves();
        require(fixture.token.transfer(address(0xCAFE), 5), "initial recipient balance missing");
        (bool ok, bytes memory data, bytes32 paymentId, bytes32 outputId) = _pay(fixture, "WITHDRAW_PAY", 1);
        require(ok, "real payment failed");
        (, uint256 amountOut) = abi.decode(data, (bytes32, uint256));
        (uint8 inputStatus,,,) = fixture.pool.getUtxo(fixture.inputId);
        (uint8 outputStatus,,,) = fixture.pool.getUtxo(outputId);
        require(inputStatus == 2 && outputStatus == 1, "Pool input/change state wrong");
        require(fixture.token.balanceOf(address(0xCAFE)) == amountOut + 5 && amountOut > 0, "delivery mismatch");
        require(fixture.adapter.isPaymentExecuted(paymentId), "payment not recorded");
        require(
            fixture.pool.isOperationExecuted(_entryId(_fixtureJson(), "WITHDRAW_PAY", "operationId")),
            "Pool operation not recorded"
        );
        require(address(fixture.adapter).balance == 0, "Adapter retained ETH");
        (uint112 reserve0After, uint112 reserve1After,) = IPairReal(fixture.pair).getReserves();
        require(reserve0After != reserve0Before && reserve1After != reserve1Before, "real pair unchanged");
        (, uint256 liability,) = fixture.pool.getAccounting();
        require(liability == DEPOSIT - 3e15, "Pool liability wrong");
    }

    function test_realOneWeiRemainder() public {
        Fixture memory fixture = _prepare();
        (bool ok,, bytes32 paymentId, bytes32 outputId) = _pay(fixture, "WITHDRAW_PAY_DUST", 1);
        require(ok && fixture.adapter.isPaymentExecuted(paymentId), "dust payment failed");
        (uint8 status,,,) = fixture.pool.getUtxo(outputId);
        require(status == 1, "dust remainder missing");
        (, uint256 liability,) = fixture.pool.getAccounting();
        require(liability == 1, "not one wei remainder");
    }

    function test_realMinimumFailureRollsBackPoolAndPair() public {
        Fixture memory fixture = _prepare();
        (uint112 reserve0Before, uint112 reserve1Before,) = IPairReal(fixture.pair).getReserves();
        uint256 pairTokenBefore = fixture.token.balanceOf(fixture.pair);
        uint256 poolEthBefore = address(fixture.pool).balance;
        (bool ok,, bytes32 paymentId, bytes32 outputId) = _pay(fixture, "WITHDRAW_PAY", type(uint256).max);
        require(!ok, "minimum failure accepted");
        (uint8 inputStatus,,,) = fixture.pool.getUtxo(fixture.inputId);
        (uint8 outputStatus,,,) = fixture.pool.getUtxo(outputId);
        require(inputStatus == 1 && outputStatus == 0, "Pool state survived failure");
        require(!fixture.adapter.isPaymentExecuted(paymentId), "Adapter success survived failure");
        require(
            !fixture.pool.isOperationExecuted(_entryId(_fixtureJson(), "WITHDRAW_PAY", "operationId")),
            "Pool success survived failure"
        );
        require(address(fixture.pool).balance == poolEthBefore, "Pool ETH survived failure");
        require(fixture.token.balanceOf(address(0xCAFE)) == 0, "recipient received failed swap");
        require(fixture.token.balanceOf(fixture.pair) == pairTokenBefore, "Pair token balance changed");
        (uint112 reserve0After, uint112 reserve1After,) = IPairReal(fixture.pair).getReserves();
        require(reserve0After == reserve0Before && reserve1After == reserve1Before, "Pair reserve changed");
        (, uint256 liability,) = fixture.pool.getAccounting();
        require(liability == DEPOSIT, "Pool liability changed");
    }

    function test_changedWithdrawalDestinationRejectsSignedPoolRequest() public {
        Fixture memory fixture = _prepare();
        (
            PoolTypes.OperationRequest memory request,
            PoolTypes.BalanceProof memory balance,
            PoolTypes.RangeProofV3[] memory ranges,
            bytes memory signature
        ) = _withdrawal("WITHDRAW_PAY");
        request.destination = address(0xCAFE);
        (bool accepted,) = FIXED_POOL.call(abi.encodeCall(IPool.withdraw, (request, balance, ranges, signature)));
        require(!accepted, "changed destination accepted");
        (uint8 inputStatus,,,) = fixture.pool.getUtxo(fixture.inputId);
        require(inputStatus == 1, "input consumed by changed destination");
    }

    receive() external payable {}
}
