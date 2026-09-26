pragma solidity 0.4.19;

import "./alt_bn128.sol";

library Transcript {
    bytes32 internal constant PARAMETERS_HASH = 0x8586da43dac1bfdfc6741c00fb62e8cc17e2ee0777f31f88e92c7369212c41ea;
    bytes32 internal constant PROTOCOL_TAG = keccak256("ecu/bp/range/BN254/v2");
    bytes32 internal constant ROLE_TAG = keccak256("ecu/bp/range-output/v2");
    bytes32 internal constant INNER_TAG = keccak256("ecu/bp/inner/v2");
    bytes32 internal constant CANDIDATE_TAG = keccak256("ecu/bp/challenge/v2");
    bytes32 internal constant ACCEPTED_TAG = keccak256("ecu/bp/accepted/v2");

    function expectedParametersHash() internal pure returns (bytes32) { return PARAMETERS_HASH; }

    function initialPrefix(bytes32 operationId, uint256 outputIndex, alt_bn128.G1Point commitment) internal pure returns (bytes memory) {
        uint256[] memory words = new uint256[](9);
        words[0] = uint256(PROTOCOL_TAG);
        words[1] = 64;
        words[2] = 1;
        words[3] = uint256(PARAMETERS_HASH);
        words[4] = uint256(operationId);
        words[5] = uint256(ROLE_TAG);
        words[6] = outputIndex;
        words[7] = commitment.X;
        words[8] = commitment.Y;
        return encodeWords(words);
    }

    function enterInner(bytes memory prefix, alt_bn128.G1Point commitment, alt_bn128.G1Point innerBase) internal pure returns (bytes memory) {
        uint256[] memory words = new uint256[](5);
        words[0] = 64;
        words[1] = commitment.X;
        words[2] = commitment.Y;
        words[3] = innerBase.X;
        words[4] = innerBase.Y;
        bytes memory payload = encodeWords(words);
        return append(prefix, INNER_TAG, payload, false, 0);
    }

    function challengeStep(bytes memory prefix, bytes32 stageTag, bytes memory payload) internal pure returns (bytes memory nextPrefix, uint256 challenge, uint256 counter) {
        bytes32 inputState = keccak256(prefix, stageTag, uint256(payload.length), payload);
        for (counter = 0; counter < 256; counter++) {
            challenge = uint256(keccak256(inputState, CANDIDATE_TAG, counter));
            if (challenge != 0 && alt_bn128.isCanonicalScalar(challenge)) {
                return (append(prefix, stageTag, payload, true, challenge), challenge, counter);
            }
        }
        revert();
    }

    function append(bytes memory prefix, bytes32 tag, bytes memory payload, bool accepted, uint256 challenge) private pure returns (bytes memory result) {
        require(prefix.length % 32 == 0 && payload.length % 32 == 0);
        result = new bytes(prefix.length + 64 + payload.length + (accepted ? 64 : 0));
        uint256 index;
        for (index = 0; index < prefix.length; index += 32) {
            assembly { mstore(add(add(result, 0x20), index), mload(add(add(prefix, 0x20), index))) }
        }
        uint256 offset = prefix.length;
        assembly { mstore(add(add(result, 0x20), offset), tag) }
        offset += 32;
        assembly { mstore(add(add(result, 0x20), offset), mload(payload)) }
        offset += 32;
        for (index = 0; index < payload.length; index += 32) {
            assembly { mstore(add(add(result, 0x20), offset), mload(add(add(payload, 0x20), index))) }
            offset += 32;
        }
        if (accepted) {
            bytes32 acceptedTag = ACCEPTED_TAG;
            assembly { mstore(add(add(result, 0x20), offset), acceptedTag) }
            offset += 32;
            assembly { mstore(add(add(result, 0x20), offset), challenge) }
        }
    }

    function encodeWords(uint256[] words) internal pure returns (bytes memory encoded) {
        encoded = new bytes(words.length * 32);
        for (uint256 index = 0; index < words.length; index++) {
            assembly {
                mstore(add(add(encoded, 0x20), mul(index, 0x20)), mload(add(add(words, 0x20), mul(index, 0x20))))
            }
        }
    }
}
