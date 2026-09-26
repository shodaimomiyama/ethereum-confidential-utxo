// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "./Bn254.sol";

library BalanceProofV3 {
    bytes32 internal constant BALANCE_TAG = keccak256("ecu/balance-schnorr/bn254/v1");
    bytes32 internal constant PARAMETERS_HASH_V3 = 0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae;

    error ChallengeExhausted();

    function isChallenge(uint256 candidate) internal pure returns (bool) {
        return candidate != 0 && candidate < Bn254.Q;
    }

    function verify(
        bytes32 operationId,
        Bn254.Point memory X,
        Bn254.Point memory R,
        uint256 s,
        Bn254.Point memory blindingBase
    ) internal view returns (bool) {
        if (!Bn254.isAllowedPoint(X, true) || !Bn254.isAllowedPoint(R, false)) revert Bn254.InvalidPoint();
        if (!Bn254.isScalar(s)) revert Bn254.InvalidScalar();
        uint256 c = challenge(operationId, X, R, blindingBase);
        return Bn254.eq(Bn254.mul(blindingBase, s), Bn254.add(R, Bn254.mul(X, c)));
    }

    function challenge(bytes32 operationId, Bn254.Point memory X, Bn254.Point memory R, Bn254.Point memory G)
        internal
        view
        returns (uint256)
    {
        for (uint256 counter; counter < 256; ++counter) {
            uint256 candidate = uint256(
                keccak256(
                    abi.encode(
                        BALANCE_TAG,
                        block.chainid,
                        msg.sender,
                        PARAMETERS_HASH_V3,
                        operationId,
                        G.x,
                        G.y,
                        X.x,
                        X.y,
                        R.x,
                        R.y,
                        counter
                    )
                )
            );
            if (isChallenge(candidate)) return candidate;
        }
        revert ChallengeExhausted();
    }
}
