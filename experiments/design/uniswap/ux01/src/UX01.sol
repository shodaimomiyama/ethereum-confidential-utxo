// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

struct Output { address owner; uint256 Cx; uint256 Cy; uint8 receiptFormat; bytes packet; }
struct OperationRequest { uint8 kind; address owner; bytes32 salt; bytes32[] inputIds; Output[] outputs; uint256 d; uint256 w; address destination; }
struct BalanceProof { uint256 Rx; uint256 Ry; uint256 s; }
struct RangeProofV3 { uint256[10] coords; uint256[5] scalars; uint256[] ls; uint256[] rs; }
struct PaymentTerms { bytes32 operationId; address owner; uint256 ethAmount; address token; uint256 minAmountOut; address recipient; uint64 deadline; }

library Signature {
    uint256 internal constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    function recover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(sig, 32)) s := mload(add(sig, 64)) v := byte(0, mload(add(sig, 96))) }
        if (uint256(r) == 0 || uint256(s) == 0 || uint256(s) > HALF_N || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }
}

contract BoundaryPool {
    // This contract deliberately stubs the balance and range proofs and stores plaintext fixture amounts.
    // It tests only the operation/authorization/asset-transfer boundary.
    bytes32 public constant OP_TAG = keccak256("ecu/operation/v1");
    bytes32 public constant INPUTS_TAG = keccak256("ecu/inputs/v1");
    bytes32 public constant OUTPUT_TAG = keccak256("ecu/output/v1");
    bytes32 public constant OUTPUTS_TAG = keccak256("ecu/outputs/v1");
    bytes32 public constant OUTPUT_ID_TAG = keccak256("ecu/output-id/v1");
    bytes32 public constant AUTH_TYPEHASH = keccak256("OperationAuthorization(bytes32 operationId,address owner,uint8 authScheme,uint8 authVersion)");
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    mapping(bytes32 => uint256) public fixtureInputValue;
    mapping(bytes32 => bool) public spent;
    mapping(bytes32 => bool) public executed;
    mapping(bytes32 => address) public changeOwner;
    mapping(bytes32 => uint256) public fixtureChangeValue;
    uint256 public totalFixtureValue;
    bool private entered;
    bytes private reentryPayCalldata;
    bool private abortAfterReentryProbes;
    bool public payReentryRejected;
    bool public fallbackReentryRejected;
    bool public wrongEthReceiptRejected;
    function configureReentryProbes(bytes calldata payCalldata, bool abortAfterProbes) external { reentryPayCalldata = payCalldata; abortAfterReentryProbes = abortAfterProbes; }
    error InvalidOperation(); error InvalidAuthorization(); error AlreadyExecuted(); error EthTransferFailed(); error ReentrantPool();
    event BoundaryWithdrawal(bytes32 indexed operationId, bytes32 indexed inputId, bytes32 indexed changeId, uint256 amount);
    function seed(bytes32 id, uint256 amount) external payable {
        if (msg.value != amount || amount == 0 || fixtureInputValue[id] != 0) revert InvalidOperation();
        fixtureInputValue[id] = amount; totalFixtureValue += amount;
    }
    function operationId(OperationRequest calldata r) public view returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](r.outputs.length);
        for (uint256 i; i < hashes.length; i++) {
            Output calldata o = r.outputs[i];
            hashes[i] = keccak256(abi.encode(OUTPUT_TAG, i, o.owner, o.Cx, o.Cy, o.receiptFormat, keccak256(o.packet)));
        }
        return keccak256(abi.encode(OP_TAG, block.chainid, address(this), r.kind, r.owner, r.salt,
            keccak256(abi.encode(INPUTS_TAG, r.inputIds)), keccak256(abi.encode(OUTPUTS_TAG, hashes)), r.d, r.w, r.destination));
    }
    function digest(OperationRequest calldata r) external view returns (bytes32) { return _digest(operationId(r), r.owner); }
    function _digest(bytes32 op, address owner) internal view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Ethereum Confidential UTXO"), keccak256("1"), block.chainid, address(this)));
        return keccak256(abi.encodePacked(hex"1901", domain, keccak256(abi.encode(AUTH_TYPEHASH, op, owner, uint8(1), uint8(1)))));
    }
    function withdraw(OperationRequest calldata r, BalanceProof calldata, RangeProofV3[] calldata proofs, bytes calldata sig) external returns (bytes32 op) {
        if (entered) revert ReentrantPool(); entered = true;
        if (r.kind != 2 || r.owner == address(0) || r.destination == address(0) || r.inputIds.length != 1 || r.outputs.length != 1 || proofs.length != 1 || r.d != 0 || r.w == 0 || r.outputs[0].owner != r.owner) revert InvalidOperation();
        bytes32 id = r.inputIds[0]; uint256 value = fixtureInputValue[id];
        if (value <= r.w || spent[id]) revert InvalidOperation();
        op = operationId(r);
        if (executed[op]) revert AlreadyExecuted();
        if (Signature.recover(_digest(op, r.owner), sig) != r.owner) revert InvalidAuthorization();
        // Proof verification is deliberately omitted. The fixture's change value stands for the proof result.
        bytes32 changeId = keccak256(abi.encode(OUTPUT_ID_TAG, op, uint256(0)));
        spent[id] = true; executed[op] = true; fixtureChangeValue[changeId] = value - r.w; changeOwner[changeId] = r.owner;
        totalFixtureValue -= r.w;
        emit BoundaryWithdrawal(op, id, changeId, r.w);
        if (reentryPayCalldata.length != 0) {
            (bool payOk, bytes memory payError) = r.destination.call(reentryPayCalldata);
            if (payOk || payError.length < 4 || bytes4(payError) != bytes4(keccak256("ReentrantPayment()"))) revert ReentrantPool();
            payReentryRejected = true;
            (bool fallbackOk, bytes memory fallbackError) = r.destination.call(hex"deadbeef");
            if (fallbackOk || fallbackError.length < 4 || bytes4(fallbackError) != bytes4(keccak256("UnexpectedEthReceipt()"))) revert ReentrantPool();
            fallbackReentryRejected = true;
            (bool receiptOk, bytes memory receiptError) = r.destination.call{value:1}("");
            if (receiptOk || receiptError.length < 4 || bytes4(receiptError) != bytes4(keccak256("UnexpectedEthReceipt()"))) revert ReentrantPool();
            wrongEthReceiptRejected = true;
            if (abortAfterReentryProbes) revert ReentrantPool();
        }
        (bool ok,) = payable(r.destination).call{value:r.w}("");
        if (!ok) revert EthTransferFailed();
        entered = false;
    }
}

interface IRouter02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function swapExactETHForTokens(uint256,address[] calldata,address,uint256) external payable returns (uint256[] memory);
}
interface IFactory { function getPair(address,address) external view returns (address); }
interface IERC20View { function balanceOf(address) external view returns (uint256); }

contract PaymentAdapter {
    BoundaryPool public immutable pool;
    IRouter02 public immutable router;
    address public immutable factory;
    address public immutable weth;
    address public immutable token;
    address public immutable pair;
    bytes32 public constant TYPEHASH = keccak256("PaymentAuthorization(bytes32 operationId,address owner,uint256 ethAmount,address token,uint256 minAmountOut,address recipient,uint64 deadline)");
    bytes32 public constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    mapping(bytes32 => bool) public executedPayments;
    bool private entered;
    bool private received;
    uint256 private expected;
    error InvalidPayment(); error InvalidPaymentSignature(); error UnsupportedToken(); error UnsupportedRecipient(); error PaymentExpired(uint64); error PaymentAlreadyExecuted(bytes32); error UnexpectedEthReceipt(); error ReentrantPayment(); error SwapAccountingMismatch(); error DeliveryMismatch();
    event PaymentSucceeded(bytes32 indexed paymentId, bytes32 indexed operationId, address indexed owner, uint256 ethAmount, address token, uint256 minAmountOut, address recipient, uint64 deadline, uint256 amountOut);
    constructor(address p, address r, address t) {
        pool = BoundaryPool(p); router = IRouter02(r); factory = router.factory(); weth = router.WETH(); token = t;
        pair = IFactory(factory).getPair(weth,t);
        if (p == address(0) || pair == address(0)) revert InvalidPayment();
    }
    function paymentDigest(PaymentTerms calldata t) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH,keccak256("Ethereum Confidential UTXO Uniswap Payment"),keccak256("1"),block.chainid,address(this)));
        return keccak256(abi.encodePacked(hex"1901",domain,keccak256(abi.encode(TYPEHASH,t.operationId,t.owner,t.ethAmount,t.token,t.minAmountOut,t.recipient,t.deadline))));
    }
    function isPaymentExecuted(bytes32 id) external view returns (bool) { return executedPayments[id]; }
    function pay(OperationRequest calldata r, BalanceProof calldata bp, RangeProofV3[] calldata rp, bytes calldata poolSig, PaymentTerms calldata t, bytes calldata paymentSig) external returns (bytes32 id,uint256 amountOut) {
        if (entered) revert ReentrantPayment(); entered = true;
        bytes32 op = pool.operationId(r);
        if (r.kind != 2 || r.inputIds.length != 1 || r.outputs.length != 1 || r.d != 0 || r.owner == address(0) || t.operationId != op || t.owner != r.owner || t.ethAmount != r.w || r.destination != address(this) || r.w == 0) revert InvalidPayment();
        if (t.token != token) revert UnsupportedToken();
        if (t.minAmountOut == 0 || t.deadline == 0) revert InvalidPayment();
        if (t.recipient == address(0) || t.recipient == address(this) || t.recipient == address(pool) || t.recipient == address(router) || t.recipient == factory || t.recipient == weth || t.recipient == token || t.recipient == pair) revert UnsupportedRecipient();
        if (block.timestamp > t.deadline) revert PaymentExpired(t.deadline);
        id = paymentDigest(t);
        if (executedPayments[id]) revert PaymentAlreadyExecuted(id);
        if (Signature.recover(id,paymentSig) != t.owner) revert InvalidPaymentSignature();
        uint256 beforeEth = address(this).balance;
        uint256 beforeToken = IERC20View(token).balanceOf(t.recipient);
        expected = t.ethAmount; received = false;
        pool.withdraw(r,bp,rp,poolSig);
        if (!received || address(this).balance != beforeEth + t.ethAmount) revert SwapAccountingMismatch();
        address[] memory path = new address[](2); path[0] = weth; path[1] = token;
        uint256[] memory amounts = router.swapExactETHForTokens{value:t.ethAmount}(t.minAmountOut,path,t.recipient,t.deadline);
        if (amounts.length != 2 || amounts[0] != t.ethAmount || amounts[1] < t.minAmountOut || amounts[1] == 0 || address(this).balance != beforeEth) revert SwapAccountingMismatch();
        amountOut = amounts[1];
        if (IERC20View(token).balanceOf(t.recipient) != beforeToken + amountOut) revert DeliveryMismatch();
        executedPayments[id] = true;
        expected = 0; received = false; entered = false;
        emit PaymentSucceeded(id,op,t.owner,t.ethAmount,t.token,t.minAmountOut,t.recipient,t.deadline,amountOut);
    }
    receive() external payable {
        if (!entered || received || msg.sender != address(pool) || msg.value != expected) revert UnexpectedEthReceipt();
        received = true;
    }
    fallback() external payable { revert UnexpectedEthReceipt(); }
}

contract DemoUSD {
    string public constant name = "Demo USD";
    string public constant symbol = "dUSD";
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from,address indexed to,uint256 value);
    event Approval(address indexed owner,address indexed spender,uint256 value);
    constructor() { totalSupply = 1_000_000 ether; balanceOf[msg.sender] = totalSupply; emit Transfer(address(0),msg.sender,totalSupply); }
    function approve(address spender,uint256 value) external returns(bool) { allowance[msg.sender][spender] = value; emit Approval(msg.sender,spender,value); return true; }
    function transfer(address to,uint256 value) external returns(bool) { _transfer(msg.sender,to,value); return true; }
    function transferFrom(address from,address to,uint256 value) external returns(bool) { uint256 a = allowance[from][msg.sender]; if (a != type(uint256).max) allowance[from][msg.sender] = a - value; _transfer(from,to,value); return true; }
    function _transfer(address from,address to,uint256 value) internal { balanceOf[from] -= value; balanceOf[to] += value; emit Transfer(from,to,value); }
}
