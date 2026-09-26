// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "./Bn254.sol";

abstract contract RangeProofV3 {
    uint256 internal constant BIT_WIDTH = 64;
    uint256 internal constant ROUNDS = 6;
    bytes32 internal constant PARAMETERS_HASH_V3 = 0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae;
    bytes32 internal constant PARAMETERS_TAG = keccak256("ecu/bp/parameters/v3");

    error InvalidParameters();

    Bn254.Point[BIT_WIDTH] public gs;
    Bn254.Point[BIT_WIDTH] public hs;
    Bn254.Point public valueBase;
    Bn254.Point public blindingBase;

    constructor(uint256[4] memory base, uint256[128] memory gsCoords, uint256[128] memory hsCoords) {
        if (calculateParametersHash(base, gsCoords, hsCoords) != PARAMETERS_HASH_V3) revert InvalidParameters();
        valueBase = Bn254.Point(base[0], base[1]);
        blindingBase = Bn254.Point(base[2], base[3]);
        if (!Bn254.isAllowedPoint(valueBase, false) || !Bn254.isAllowedPoint(blindingBase, false)) {
            revert InvalidParameters();
        }
        for (uint256 i; i < BIT_WIDTH; ++i) {
            Bn254.Point memory g = Bn254.Point(gsCoords[i], gsCoords[BIT_WIDTH + i]);
            Bn254.Point memory h = Bn254.Point(hsCoords[i], hsCoords[BIT_WIDTH + i]);
            if (!Bn254.isAllowedPoint(g, false) || !Bn254.isAllowedPoint(h, false)) revert InvalidParameters();
            gs[i] = g;
            hs[i] = h;
        }
    }

    function parametersHash() external pure returns (bytes32) {
        return PARAMETERS_HASH_V3;
    }

    function calculateParametersHash(uint256[4] memory base, uint256[128] memory gsCoords, uint256[128] memory hsCoords)
        internal
        pure
        returns (bytes32 digest)
    {
        uint256[262] memory words;
        words[0] = uint256(PARAMETERS_TAG);
        words[1] = BIT_WIDTH;
        for (uint256 i; i < 4; ++i) {
            words[2 + i] = base[i];
        }
        for (uint256 i; i < BIT_WIDTH; ++i) {
            words[6 + 2 * i] = gsCoords[i];
            words[7 + 2 * i] = gsCoords[BIT_WIDTH + i];
            words[134 + 2 * i] = hsCoords[i];
            words[135 + 2 * i] = hsCoords[BIT_WIDTH + i];
        }
        assembly { digest := keccak256(words, 8384) }
    }
}
