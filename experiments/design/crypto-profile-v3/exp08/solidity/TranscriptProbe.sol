pragma solidity 0.4.19;

import "./Transcript.sol";

contract TranscriptProbe {
    function allowedPoint(uint256 x, uint256 y) public pure returns (bool) {
        return alt_bn128.isAllowedPoint(alt_bn128.G1Point(x, y), true);
    }

    function initial(bytes32 operationId, uint256 outputIndex, uint256 x, uint256 y) public pure returns (bytes) {
        return Transcript.initialPrefix(operationId, outputIndex, alt_bn128.G1Point(x, y));
    }

    function challenge(bytes prefix, bytes32 stageTag, bytes payload) public pure returns (bytes, uint256, uint256) {
        return Transcript.challengeStep(prefix, stageTag, payload);
    }

    function inner(bytes prefix, uint256 px, uint256 py, uint256 ux, uint256 uy) public pure returns (bytes) {
        return Transcript.enterInner(prefix, alt_bn128.G1Point(px, py), alt_bn128.G1Point(ux, uy));
    }
}
