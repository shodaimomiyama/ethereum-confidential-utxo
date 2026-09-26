pragma solidity 0.4.19;

import "./alt_bn128.sol";
import "./Transcript.sol";

contract VerifierTestHelper {
    function candidateAllowed(uint256 candidate) public pure returns (bool) {
        return Transcript.isChallengeCandidate(candidate);
    }

    function scalarAllowed(uint256 scalar) public pure returns (bool) {
        return alt_bn128.isCanonicalScalar(scalar);
    }

    function pointAllowed(uint256 coordinateX, uint256 coordinateY, bool allowIdentity) public pure returns (bool) {
        return alt_bn128.isAllowedPoint(alt_bn128.G1Point(coordinateX, coordinateY), allowIdentity);
    }

    function challengeStep(bytes32 previousState, bytes32 stageTag, bytes payload) public pure returns (bytes32 nextState, uint256 challenge, uint256 counter) {
        return Transcript.challengeStep(previousState, stageTag, payload);
    }

    function initialState(bytes32 operationId, uint256 outputIndex, uint256 coordinateX, uint256 coordinateY) public pure returns (bytes32) {
        return Transcript.initialState(operationId, outputIndex, alt_bn128.G1Point(coordinateX, coordinateY));
    }

    function innerState(bytes32 state, uint256[4] points) public pure returns (bytes32) {
        return Transcript.enterInner(state, alt_bn128.G1Point(points[0], points[1]), alt_bn128.G1Point(points[2], points[3]));
    }

    function negateScalar(uint256 scalar) public pure returns (uint256) {
        return alt_bn128.neg(scalar);
    }

    function invertScalar(uint256 scalar) public view returns (uint256) {
        return alt_bn128.inv(scalar);
    }
}
