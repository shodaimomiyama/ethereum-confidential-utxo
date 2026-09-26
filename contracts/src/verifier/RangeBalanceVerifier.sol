// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "./Bn254.sol";
import {BalanceProofV3} from "./BalanceProofV3.sol";
import {RangeProofV3} from "./RangeProofV3.sol";

contract RangeBalanceVerifier is RangeProofV3 {
    constructor(uint256[4] memory base, uint256[128] memory gsCoords, uint256[128] memory hsCoords)
        RangeProofV3(base, gsCoords, hsCoords)
    {}

    function verifyBalance(bytes32 operationId, uint256 Xx, uint256 Xy, uint256 Rx, uint256 Ry, uint256 s)
        external
        view
        returns (bool)
    {
        return BalanceProofV3.verify(operationId, Bn254.Point(Xx, Xy), Bn254.Point(Rx, Ry), s, blindingBase);
    }
}
