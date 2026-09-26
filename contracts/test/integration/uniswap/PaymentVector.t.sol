// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract PaymentVectorTest {
    event PaymentDigest(bytes32 digest);

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PAYMENT_TYPEHASH = keccak256(
        "PaymentAuthorization(bytes32 operationId,address owner,uint256 ethAmount,address token,uint256 minAmountOut,address recipient,uint64 deadline)"
    );

    function paymentDigest() public pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("Ethereum Confidential UTXO Uniswap Payment"),
                keccak256("1"),
                uint256(31337),
                address(0x5555555555555555555555555555555555555555)
            )
        );
        bytes32 payload = keccak256(
            abi.encode(
                PAYMENT_TYPEHASH,
                bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
                address(0x2222222222222222222222222222222222222222),
                uint256(1 ether),
                address(0x3333333333333333333333333333333333333333),
                uint256(99),
                address(0x4444444444444444444444444444444444444444),
                uint64(600)
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, payload));
    }

    function test_emitIndependentPaymentDigest() public {
        bytes32 digest = paymentDigest();
        require(
            digest == 0x65b68bd6858a7947aef50aa010ad17946ee527a79ebc0d7185603fbfe70f157c,
            "payment digest"
        );
        emit PaymentDigest(digest);
    }
}
