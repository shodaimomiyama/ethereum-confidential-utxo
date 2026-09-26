pragma solidity 0.4.19;

library alt_bn128 {
    uint256 internal constant q = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant p = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    struct G1Point {
        uint256 X;
        uint256 Y;
    }

    function isCanonicalScalar(uint256 scalar) internal pure returns (bool) {
        return scalar < q;
    }

    function isAllowedPoint(G1Point point, bool allowIdentity) internal pure returns (bool) {
        if (point.X >= p || point.Y >= p) return false;
        if (point.X == 0 && point.Y == 0) return allowIdentity;
        return mulmod(point.Y, point.Y, p) == addmod(mulmod(mulmod(point.X, point.X, p), point.X, p), 3, p);
    }

    function add(G1Point first, G1Point second) internal view returns (G1Point sum) {
        require(isAllowedPoint(first, true) && isAllowedPoint(second, true));
        uint256[4] memory input;
        input[0] = first.X;
        input[1] = first.Y;
        input[2] = second.X;
        input[3] = second.Y;
        assembly {
            if iszero(staticcall(not(0), 6, input, 0x80, sum, 0x40)) { revert(0, 0) }
            if iszero(eq(returndatasize, 0x40)) { revert(0, 0) }
        }
    }

    function mul(G1Point point, uint256 scalar) internal view returns (G1Point product) {
        require(isAllowedPoint(point, true) && isCanonicalScalar(scalar));
        uint256[3] memory input;
        input[0] = point.X;
        input[1] = point.Y;
        input[2] = scalar;
        assembly {
            if iszero(staticcall(not(0), 7, input, 0x60, product, 0x40)) { revert(0, 0) }
            if iszero(eq(returndatasize, 0x40)) { revert(0, 0) }
        }
    }

    function neg(G1Point point) internal pure returns (G1Point) {
        require(isAllowedPoint(point, true));
        if (point.X == 0 && point.Y == 0) return G1Point(0, 0);
        return G1Point(point.X, point.Y == 0 ? 0 : p - point.Y);
    }

    function eq(G1Point first, G1Point second) internal pure returns (bool) {
        return first.X == second.X && first.Y == second.Y;
    }

    function add(uint256 first, uint256 second) internal pure returns (uint256) {
        require(isCanonicalScalar(first) && isCanonicalScalar(second));
        return addmod(first, second, q);
    }

    function mul(uint256 first, uint256 second) internal pure returns (uint256) {
        require(isCanonicalScalar(first) && isCanonicalScalar(second));
        return mulmod(first, second, q);
    }

    function sub(uint256 first, uint256 second) internal pure returns (uint256) {
        require(isCanonicalScalar(first) && isCanonicalScalar(second));
        return first >= second ? first - second : q - second + first;
    }

    function neg(uint256 scalar) internal pure returns (uint256) {
        require(isCanonicalScalar(scalar));
        return scalar == 0 ? 0 : q - scalar;
    }

    function inv(uint256 scalar) internal view returns (uint256) {
        require(scalar != 0 && isCanonicalScalar(scalar));
        return exp(scalar, q - 2);
    }

    function exp(uint256 base, uint256 exponent) internal view returns (uint256) {
        require(isCanonicalScalar(base));
        uint256[6] memory input;
        uint256[1] memory output;
        input[0] = 0x20;
        input[1] = 0x20;
        input[2] = 0x20;
        input[3] = base;
        input[4] = exponent;
        input[5] = q;
        assembly {
            if iszero(staticcall(not(0), 5, input, 0xc0, output, 0x20)) { revert(0, 0) }
            if iszero(eq(returndatasize, 0x20)) { revert(0, 0) }
        }
        require(isCanonicalScalar(output[0]));
        return output[0];
    }
}
