pragma solidity 0.4.19;

import "../src/alt_bn128.sol";

contract VerifierSliceTest {
    uint256 constant SCALAR_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function test_subCanonicalInputsStayCanonical(uint256 left, uint256 right) public pure {
        if (left >= SCALAR_ORDER || right >= SCALAR_ORDER) return;
        uint256 difference = alt_bn128.sub(left, right);
        assert(difference < SCALAR_ORDER);
    }

    function test_negZeroReturnsZero() public pure {
        assert(alt_bn128.neg(uint256(0)) == 0);
    }

    function test_subBoundaryInputsStayCanonical() public pure {
        assert(alt_bn128.sub(uint256(0), uint256(0)) == 0);
        assert(alt_bn128.sub(uint256(0), SCALAR_ORDER - 1) == 1);
        assert(alt_bn128.sub(SCALAR_ORDER - 1, uint256(0)) == SCALAR_ORDER - 1);
        assert(alt_bn128.sub(SCALAR_ORDER - 1, SCALAR_ORDER - 1) == 0);
        assert(alt_bn128.sub(uint256(1), uint256(2)) == SCALAR_ORDER - 1);
        assert(alt_bn128.sub(uint256(2), uint256(1)) == 1);
    }
}
