// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "./Bn254.sol";

library RangeTranscriptV3 {
    bytes32 internal constant PARAMETERS_HASH = 0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae;
    bytes32 internal constant PROTOCOL_TAG = keccak256("ecu/bp/range/BN254/v3");
    bytes32 internal constant ROLE_TAG = keccak256("ecu/bp/range-output/v3");
    bytes32 internal constant INNER_TAG = keccak256("ecu/bp/inner/v3");
    bytes32 internal constant CANDIDATE_TAG = keccak256("ecu/bp/challenge/v3");
    bytes32 internal constant ACCEPTED_TAG = keccak256("ecu/bp/accepted/v3");

    error ChallengeExhausted();

    function initialPrefix(bytes32 operationId, uint256 outputIndex, Bn254.Point memory commitment)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            PROTOCOL_TAG,
            uint256(64),
            uint256(1),
            PARAMETERS_HASH,
            operationId,
            ROLE_TAG,
            outputIndex,
            commitment.x,
            commitment.y
        );
    }

    function enterInner(bytes memory prefix, Bn254.Point memory commitment, Bn254.Point memory innerBase)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory payload = abi.encode(uint256(64), commitment.x, commitment.y, innerBase.x, innerBase.y);
        return bytes.concat(prefix, abi.encode(INNER_TAG, uint256(payload.length)), payload);
    }

    function isChallenge(uint256 candidate) internal pure returns (bool) {
        return candidate != 0 && candidate < Bn254.Q;
    }

    function encodeWords(uint256[] memory words) internal pure returns (bytes memory encoded) {
        encoded = new bytes(words.length * 32);
        for (uint256 i; i < words.length; ++i) {
            uint256 word = words[i];
            assembly { mstore(add(add(encoded, 0x20), mul(i, 0x20)), word) }
        }
    }

    function challengeStep(bytes memory prefix, bytes32 stageTag, bytes memory payload)
        internal
        pure
        returns (bytes memory nextPrefix, uint256 challenge, uint256 counter)
    {
        for (counter = 0; counter < 256; ++counter) {
            challenge = uint256(
                keccak256(
                    bytes.concat(
                        prefix,
                        abi.encode(stageTag, uint256(payload.length)),
                        payload,
                        abi.encode(CANDIDATE_TAG, counter)
                    )
                )
            );
            if (isChallenge(challenge)) {
                nextPrefix = bytes.concat(
                    prefix, abi.encode(stageTag, uint256(payload.length)), payload, abi.encode(ACCEPTED_TAG, challenge)
                );
                return (nextPrefix, challenge, counter);
            }
        }
        revert ChallengeExhausted();
    }
}
