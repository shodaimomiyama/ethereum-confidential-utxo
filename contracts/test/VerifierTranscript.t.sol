// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "../src/verifier/Bn254.sol";
import {RangeTranscriptV3} from "../src/verifier/RangeTranscriptV3.sol";
import {VerifierVectors} from "./fixtures/VerifierVectors.sol";

contract TranscriptProbe {
    function firstChallenges()
        external
        pure
        returns (
            bytes32 initialHash,
            uint256 y,
            uint256 z,
            uint256 yCounter,
            uint256 zCounter,
            bytes32 yHash,
            bytes32 zHash
        )
    {
        bytes memory prefix = RangeTranscriptV3.initialPrefix(
            bytes32(uint256(0x6666666666666666666666666666666666666666666666666666666666666666)), 0, Bn254.Point(0, 0)
        );
        initialHash = keccak256(prefix);
        bytes memory payload = abi.encode(
            uint256(14165919674099329718601580964657632544067262668980129663386607317807763436327),
            uint256(14506971073191905251918047963949154006736651777746917029143953817943306263371),
            uint256(6855676512248732214304583679695678591595093293461787472283489702420133439061),
            uint256(17712693933233813412212224713853073285653520663472514980187370713688711424433)
        );
        (prefix, y, yCounter) = RangeTranscriptV3.challengeStep(prefix, keccak256("ecu/bp/y/v3"), payload);
        yHash = keccak256(prefix);
        (prefix, z, zCounter) = RangeTranscriptV3.challengeStep(prefix, keccak256("ecu/bp/z/v3"), hex"");
        zHash = keccak256(prefix);
    }
}

contract VerifierTranscriptTest {
    function test_fullPrefixYAndEmptyZMatchIndependentTrace() public {
        (bytes32 initialHash, uint256 y, uint256 z, uint256 yc, uint256 zc, bytes32 yHash, bytes32 zHash) =
            (new TranscriptProbe()).firstChallenges();
        require(initialHash == 0x5d2d65f2f390cab2c662c4c41c8e681bf248453437404f75605d0dcd94c4ad35);
        require(y == 13877242284335468697909311302832010809980947879333272021950837233674102626977 && yc == 3);
        require(yHash == 0x687e3f84a7ef92982f0973eb0cb283a92baae0f91e4ef35431f10b0433954884);
        require(z == 563040286126028909383346011381070455092075070827294663182355053703395208832 && zc == 3);
        require(zHash == 0x02b7b402b0aa17a9ff1c1fbe668ba3b50490543d4c63a3292846443291a8d5f9);
    }

    function test_allStagesMatchIndependentTrace() public pure {
        bytes memory prefix = RangeTranscriptV3.initialPrefix(
            0x6666666666666666666666666666666666666666666666666666666666666666, 0, Bn254.Point(0, 0)
        );
        for (uint256 i; i < 11; ++i) {
            (
                bytes32 tag,
                bytes memory payload,
                bytes32 expectedHash,
                uint256 expectedChallenge,
                uint256 expectedCounter,
                bool inner
            ) = VerifierVectors.rangeTraceStep(i);
            if (inner) {
                (uint256 width, uint256 px, uint256 py, uint256 ux, uint256 uy) =
                    abi.decode(payload, (uint256, uint256, uint256, uint256, uint256));
                require(width == 64);
                prefix = RangeTranscriptV3.enterInner(prefix, Bn254.Point(px, py), Bn254.Point(ux, uy));
            } else {
                uint256 challenge;
                uint256 counter;
                (prefix, challenge, counter) = RangeTranscriptV3.challengeStep(prefix, tag, payload);
                require(challenge == expectedChallenge && counter == expectedCounter, "challenge differs");
            }
            require(keccak256(prefix) == expectedHash, "prefix differs");
        }
    }
}
