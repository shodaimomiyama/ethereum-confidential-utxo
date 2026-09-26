// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

library Bn254 {
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 internal constant Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error InvalidPoint();
    error InvalidScalar();
    error PrecompileFailure();

    struct Point {
        uint256 x;
        uint256 y;
    }

    function isScalar(uint256 scalar) internal pure returns (bool) {
        return scalar < Q;
    }

    function isAllowedPoint(Point memory point, bool allowIdentity) internal pure returns (bool) {
        if (point.x >= P || point.y >= P) return false;
        if (point.x == 0 && point.y == 0) return allowIdentity;
        return mulmod(point.y, point.y, P) == addmod(mulmod(mulmod(point.x, point.x, P), point.x, P), 3, P);
    }

    function rawStaticCall(address target, bytes memory input, uint256 expectedLength)
        internal
        view
        returns (bytes memory output)
    {
        (bool success, bytes memory returndata) = target.staticcall(input);
        if (!success || returndata.length != expectedLength) revert PrecompileFailure();
        return returndata;
    }

    function add(Point memory first, Point memory second) internal view returns (Point memory result) {
        if (!isAllowedPoint(first, true) || !isAllowedPoint(second, true)) revert InvalidPoint();
        bytes memory output = rawStaticCall(address(0x06), abi.encode(first.x, first.y, second.x, second.y), 64);
        (result.x, result.y) = abi.decode(output, (uint256, uint256));
        if (!isAllowedPoint(result, true)) revert PrecompileFailure();
    }

    function mul(Point memory point, uint256 scalar) internal view returns (Point memory result) {
        if (!isAllowedPoint(point, true)) revert InvalidPoint();
        if (!isScalar(scalar)) revert InvalidScalar();
        bytes memory output = rawStaticCall(address(0x07), abi.encode(point.x, point.y, scalar), 64);
        (result.x, result.y) = abi.decode(output, (uint256, uint256));
        if (!isAllowedPoint(result, true)) revert PrecompileFailure();
    }

    function neg(Point memory point) internal pure returns (Point memory) {
        if (!isAllowedPoint(point, true)) revert InvalidPoint();
        if (point.x == 0 && point.y == 0) return Point(0, 0);
        return Point(point.x, point.y == 0 ? 0 : P - point.y);
    }

    function eq(Point memory first, Point memory second) internal pure returns (bool) {
        return first.x == second.x && first.y == second.y;
    }

    function addScalar(uint256 first, uint256 second) internal pure returns (uint256) {
        if (!isScalar(first) || !isScalar(second)) revert InvalidScalar();
        return addmod(first, second, Q);
    }

    function add(uint256 first, uint256 second) internal pure returns (uint256) {
        return addScalar(first, second);
    }

    function subScalar(uint256 first, uint256 second) internal pure returns (uint256) {
        if (!isScalar(first) || !isScalar(second)) revert InvalidScalar();
        return first >= second ? first - second : Q - (second - first);
    }

    function sub(uint256 first, uint256 second) internal pure returns (uint256) {
        return subScalar(first, second);
    }

    function neg(uint256 scalar) internal pure returns (uint256) {
        if (!isScalar(scalar)) revert InvalidScalar();
        return scalar == 0 ? 0 : Q - scalar;
    }

    function mulScalar(uint256 first, uint256 second) internal pure returns (uint256) {
        if (!isScalar(first) || !isScalar(second)) revert InvalidScalar();
        return mulmod(first, second, Q);
    }

    function mul(uint256 first, uint256 second) internal pure returns (uint256) {
        return mulScalar(first, second);
    }

    function invScalar(uint256 scalar) internal view returns (uint256) {
        if (scalar == 0 || !isScalar(scalar)) revert InvalidScalar();
        return expScalar(scalar, Q - 2);
    }

    function inv(uint256 scalar) internal view returns (uint256) {
        return invScalar(scalar);
    }

    function expScalar(uint256 base, uint256 exponent) internal view returns (uint256 result) {
        if (!isScalar(base)) revert InvalidScalar();
        bytes memory output =
            rawStaticCall(address(0x05), abi.encode(uint256(32), uint256(32), uint256(32), base, exponent, Q), 32);
        result = abi.decode(output, (uint256));
        if (!isScalar(result)) revert PrecompileFailure();
    }
}
