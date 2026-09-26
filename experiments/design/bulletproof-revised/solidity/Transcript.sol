pragma solidity 0.4.19;

import "./alt_bn128.sol";

library Transcript {
    bytes32 internal constant PARAMETERS_HASH = 0xe821fd9270e0c24773647d479012c2b4f4a6f5576f6bd09881e8838a0ca29d51;
    bytes32 internal constant PROTOCOL_TAG = keccak256("ecu/bp/range/BN254/v1");
    bytes32 internal constant ROLE_TAG = keccak256("ecu/bp/range-output/v1");
    bytes32 internal constant INNER_TAG = keccak256("ecu/bp/inner/v1");
    bytes32 internal constant CANDIDATE_TAG = keccak256("ecu/bp/challenge/v1");
    bytes32 internal constant ACCEPTED_TAG = keccak256("ecu/bp/accepted/v1");

    function expectedParametersHash() internal pure returns (bytes32) {
        return PARAMETERS_HASH;
    }

    function isChallengeCandidate(uint256 candidate) internal pure returns (bool) {
        return candidate != 0 && alt_bn128.isCanonicalScalar(candidate);
    }

    function initialState(bytes32 operationId, uint256 outputIndex, alt_bn128.G1Point commitment) internal pure returns (bytes32) {
        return keccak256(PROTOCOL_TAG, uint256(64), uint256(1), PARAMETERS_HASH, operationId, ROLE_TAG, outputIndex, commitment.X, commitment.Y);
    }

    function enterInner(bytes32 state, alt_bn128.G1Point commitment, alt_bn128.G1Point innerBase) internal pure returns (bytes32) {
        return keccak256(state, INNER_TAG, uint256(64), commitment.X, commitment.Y, innerBase.X, innerBase.Y);
    }

    function challengeStep(bytes32 previousState, bytes32 stageTag, bytes payload) internal pure returns (bytes32 nextState, uint256 challenge, uint256 counter) {
        bytes32 inputState = keccak256(previousState, stageTag, payload);
        for (counter = 0; counter < 256; counter++) {
            challenge = uint256(keccak256(inputState, CANDIDATE_TAG, counter));
            if (isChallengeCandidate(challenge)) {
                nextState = keccak256(inputState, ACCEPTED_TAG, challenge);
                return (nextState, challenge, counter);
            }
        }
        revert();
    }

    function encodeWords(uint256[] words) internal pure returns (bytes) {
        bytes memory encoded = new bytes(words.length * 32);
        for (uint256 index = 0; index < words.length; index++) {
            assembly {
                mstore(add(add(encoded, 0x20), mul(index, 0x20)), mload(add(add(words, 0x20), mul(index, 0x20))))
            }
        }
        return encoded;
    }
}
