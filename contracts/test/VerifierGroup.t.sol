// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "../src/verifier/Bn254.sol";

contract GroupProbe {
    function allowed(uint256 x, uint256 y, bool allowIdentity) external pure returns (bool) {
        return Bn254.isAllowedPoint(Bn254.Point(x, y), allowIdentity);
    }

    function scalar(uint256 value) external pure returns (bool) {
        return Bn254.isScalar(value);
    }

    function negative(uint256 x, uint256 y) external pure returns (uint256, uint256) {
        Bn254.Point memory result = Bn254.neg(Bn254.Point(x, y));
        return (result.x, result.y);
    }

    function sumWithNegative(uint256 x, uint256 y) external view returns (uint256, uint256) {
        Bn254.Point memory point = Bn254.Point(x, y);
        Bn254.Point memory result = Bn254.add(point, Bn254.neg(point));
        return (result.x, result.y);
    }

    function callRaw(address target, uint256 expectedLength) external view returns (bytes memory) {
        return Bn254.rawStaticCall(target, hex"", expectedLength);
    }
}

contract FaultTarget {
    uint256 private immutable outputLength;

    constructor(uint256 length) {
        outputLength = length;
    }

    fallback() external {
        uint256 length = outputLength;
        assembly { return(0, length) }
    }
}

contract RevertingTarget {
    fallback() external {
        revert();
    }
}

contract VerifierGroupTest {
    uint256 private constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 private constant Q = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 private constant GX = 10761899322201753907488574554624072832672186484354855590619514852343117816213;
    uint256 private constant GY = 13379372057202721286017964291077114196925452861447087137187819632002026932859;

    GroupProbe private probe;

    function setUp() public {
        probe = new GroupProbe();
    }

    function test_identityAndNonCanonical() public view {
        require(probe.allowed(0, 0, true));
        require(!probe.allowed(0, 0, false));
        require(!probe.allowed(P, 1, true));
        require(!probe.allowed(1, 1, true));
        require(probe.scalar(0) && probe.scalar(Q - 1) && !probe.scalar(Q));
    }

    function test_groupInverseAndIdentity() public view {
        (uint256 nx, uint256 ny) = probe.negative(0, 0);
        require(nx == 0 && ny == 0);
        (uint256 sx, uint256 sy) = probe.sumWithNegative(GX, GY);
        require(sx == 0 && sy == 0);
    }

    function test_precompileFailureAndWrongLengthRevert() public {
        RevertingTarget bad = new RevertingTarget();
        try probe.callRaw(address(bad), 64) {
            revert("accepted failed call");
        } catch {}
        uint256[5] memory lengths = [uint256(0), 31, 33, 63, 65];
        for (uint256 i; i < lengths.length; ++i) {
            FaultTarget target = new FaultTarget(lengths[i]);
            try probe.callRaw(address(target), 64) {
                revert("accepted wrong length");
            } catch {}
        }
    }
}
