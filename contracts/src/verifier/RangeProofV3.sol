// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Bn254} from "./Bn254.sol";
import {RangeTranscriptV3} from "./RangeTranscriptV3.sol";

abstract contract RangeProofV3 {
    using Bn254 for uint256;
    using Bn254 for Bn254.Point;

    uint256 internal constant TWO_TO_64_MINUS_ONE = 18446744073709551615;
    bytes32 internal constant Y_TAG = keccak256("ecu/bp/y/v3");
    bytes32 internal constant Z_TAG = keccak256("ecu/bp/z/v3");
    bytes32 internal constant X_TAG = keccak256("ecu/bp/x/v3");
    bytes32 internal constant U_TAG = keccak256("ecu/bp/u/v3");
    bytes32 internal constant ROUND_TAG = keccak256("ecu/bp/round/v3");
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

    struct RangeProof {
        Bn254.Point commitmentA;
        Bn254.Point commitmentS;
        Bn254.Point[2] coefficientCommitments;
        uint256 tauX;
        uint256 mu;
        uint256 t;
        Bn254.Point[ROUNDS] left;
        Bn254.Point[ROUNDS] right;
        uint256 scalarA;
        uint256 scalarB;
    }

    struct RangeBoard {
        bytes transcriptState;
        uint256 y;
        uint256[BIT_WIDTH] powersOfY;
        uint256 z;
        uint256 zSquared;
        uint256 zCubed;
        uint256 x;
        uint256 delta;
        uint256 uChallenge;
        Bn254.Point innerBase;
        Bn254.Point innerCommitment;
    }

    struct InnerBoard {
        bytes transcriptState;
        Bn254.Point commitment;
        uint256 challenge;
        uint256 inverseChallenge;
        uint256[ROUNDS] challenges;
        uint256[BIT_WIDTH] weights;
        Bn254.Point foldedG;
        Bn254.Point foldedH;
        Bn254.Point expectedCommitment;
    }

    function verify(
        bytes32 operationId,
        uint256 outputIndex,
        uint256[10] calldata coords,
        uint256[5] calldata scalars,
        uint256[] calldata ls,
        uint256[] calldata rs
    ) external view returns (bool) {
        RangeProof memory proof = decodeProof(coords, scalars, ls, rs);
        Bn254.Point memory inputCommitment = Bn254.Point(coords[0], coords[1]);
        return
            verifyRange(
                inputCommitment, proof, RangeTranscriptV3.initialPrefix(operationId, outputIndex, inputCommitment)
            );
    }

    function decodeProof(uint256[10] memory coords, uint256[5] memory scalars, uint256[] memory ls, uint256[] memory rs)
        internal
        pure
        returns (RangeProof memory proof)
    {
        require(ls.length == 2 * ROUNDS && rs.length == 2 * ROUNDS);
        require(Bn254.isAllowedPoint(Bn254.Point(coords[0], coords[1]), true));
        for (uint256 index = 0; index < 5; index++) {
            require(Bn254.isScalar(scalars[index]));
        }
        proof.commitmentA = Bn254.Point(coords[2], coords[3]);
        proof.commitmentS = Bn254.Point(coords[4], coords[5]);
        proof.coefficientCommitments[0] = Bn254.Point(coords[6], coords[7]);
        proof.coefficientCommitments[1] = Bn254.Point(coords[8], coords[9]);
        require(Bn254.isAllowedPoint(proof.commitmentA, true));
        require(Bn254.isAllowedPoint(proof.commitmentS, true));
        require(Bn254.isAllowedPoint(proof.coefficientCommitments[0], true));
        require(Bn254.isAllowedPoint(proof.coefficientCommitments[1], true));
        proof.tauX = scalars[0];
        proof.mu = scalars[1];
        proof.t = scalars[2];
        proof.scalarA = scalars[3];
        proof.scalarB = scalars[4];
        for (uint256 index = 0; index < ROUNDS; index++) {
            proof.left[index] = Bn254.Point(ls[index], ls[ROUNDS + index]);
            proof.right[index] = Bn254.Point(rs[index], rs[ROUNDS + index]);
            require(Bn254.isAllowedPoint(proof.left[index], true));
            require(Bn254.isAllowedPoint(proof.right[index], true));
        }
    }

    function verifyRange(Bn254.Point memory inputCommitment, RangeProof memory proof, bytes memory initialState)
        internal
        view
        returns (bool)
    {
        RangeBoard memory board;
        (board.transcriptState, board.y) = challengeForPoints(initialState, Y_TAG, proof.commitmentA, proof.commitmentS);
        board.powersOfY = powers(board.y);
        (board.transcriptState, board.z,) = RangeTranscriptV3.challengeStep(board.transcriptState, Z_TAG, new bytes(0));
        board.zSquared = board.z.mul(board.z);
        board.zCubed = board.zSquared.mul(board.z);
        (board.transcriptState, board.x) = challengeForPoints(
            board.transcriptState, X_TAG, proof.coefficientCommitments[0], proof.coefficientCommitments[1]
        );
        board.delta =
            sumScalars(board.powersOfY).mul(board.z.sub(board.zSquared)).sub(board.zCubed.mul(TWO_TO_64_MINUS_ONE));
        if (!satisfiesPolynomialCommitment(inputCommitment, proof, board)) return false;
        (board.transcriptState, board.uChallenge) =
            challengeForScalars(board.transcriptState, proof.tauX, proof.mu, proof.t);
        board.innerBase = valueBase.mul(board.uChallenge);
        Bn254.Point[BIT_WIDTH] memory hPrimes = inverseScaleGenerators(board.powersOfY);
        board.innerCommitment = deriveInnerCommitment(proof, board, hPrimes);
        board.transcriptState =
            RangeTranscriptV3.enterInner(board.transcriptState, board.innerCommitment, board.innerBase);
        return verifyInner(board.transcriptState, board.innerCommitment, board.innerBase, hPrimes, proof);
    }

    function satisfiesPolynomialCommitment(
        Bn254.Point memory inputCommitment,
        RangeProof memory proof,
        RangeBoard memory board
    ) internal view returns (bool) {
        Bn254.Point memory expected = valueBase.mul(proof.t).add(blindingBase.mul(proof.tauX));
        Bn254.Point memory actual = proof.coefficientCommitments[0].mul(board.x);
        actual = actual.add(proof.coefficientCommitments[1].mul(board.x.mul(board.x)));
        actual = actual.add(inputCommitment.mul(board.zSquared));
        actual = actual.add(valueBase.mul(board.delta));
        return actual.eq(expected);
    }

    function deriveInnerCommitment(
        RangeProof memory proof,
        RangeBoard memory board,
        Bn254.Point[BIT_WIDTH] memory hPrimes
    ) internal view returns (Bn254.Point memory commitment) {
        uint256[BIT_WIDTH] memory exponents;
        uint256 powerOfTwo = 1;
        for (uint256 index = 0; index < BIT_WIDTH; index++) {
            exponents[index] = board.powersOfY[index].mul(board.z).add(powerOfTwo.mul(board.zSquared));
            powerOfTwo = powerOfTwo.mul(2);
        }
        commitment = proof.commitmentA.add(proof.commitmentS.mul(board.x));
        commitment = commitment.add(sumPoints(gs).mul(board.z.neg()));
        commitment = commitment.add(commit(hPrimes, exponents));
        commitment = commitment.add(blindingBase.mul(proof.mu).neg());
        commitment = commitment.add(board.innerBase.mul(proof.t));
    }

    function verifyInner(
        bytes memory state,
        Bn254.Point memory commitment,
        Bn254.Point memory innerBase,
        Bn254.Point[BIT_WIDTH] memory hPrimes,
        RangeProof memory proof
    ) internal view returns (bool) {
        InnerBoard memory board;
        board.transcriptState = state;
        board.commitment = commitment;
        for (uint256 roundIndex = 0; roundIndex < ROUNDS; roundIndex++) {
            (board.transcriptState, board.challenge) =
                challengeForRound(board.transcriptState, roundIndex, proof.left[roundIndex], proof.right[roundIndex]);
            board.inverseChallenge = board.challenge.inv();
            board.commitment = proof.left[roundIndex]
                .mul(board.challenge.mul(board.challenge))
                .add(proof.right[roundIndex].mul(board.inverseChallenge.mul(board.inverseChallenge)))
                .add(board.commitment);
            board.challenges[roundIndex] = board.challenge;
        }
        board.weights = calculateInnerWeights(board.challenges);
        board.foldedG = commit(gs, board.weights);
        board.foldedH = commitReversed(hPrimes, board.weights);
        board.expectedCommitment = board.foldedG
            .mul(proof.scalarA)
            .add(board.foldedH.mul(proof.scalarB))
            .add(innerBase.mul(proof.scalarA.mul(proof.scalarB)));
        return board.expectedCommitment.eq(board.commitment);
    }

    function calculateInnerWeights(uint256[ROUNDS] memory challenges)
        internal
        view
        returns (uint256[BIT_WIDTH] memory weights)
    {
        uint256 product = 1;
        for (uint256 roundIndex = 0; roundIndex < ROUNDS; roundIndex++) {
            product = product.mul(challenges[roundIndex]);
        }
        uint256 inverseProduct = product.inv();
        for (uint256 index = 0; index < BIT_WIDTH; index++) {
            weights[index] = inverseProduct;
            for (uint256 bitIndex = 0; bitIndex < ROUNDS; bitIndex++) {
                if ((index & (uint256(1) << bitIndex)) != 0) {
                    uint256 challenge = challenges[ROUNDS - 1 - bitIndex];
                    weights[index] = weights[index].mul(challenge.mul(challenge));
                }
            }
        }
    }

    function challengeForPoints(
        bytes memory state,
        bytes32 stageTag,
        Bn254.Point memory first,
        Bn254.Point memory second
    ) internal pure returns (bytes memory nextState, uint256 challenge) {
        uint256[] memory words = new uint256[](4);
        words[0] = first.x;
        words[1] = first.y;
        words[2] = second.x;
        words[3] = second.y;
        (nextState, challenge,) = RangeTranscriptV3.challengeStep(state, stageTag, RangeTranscriptV3.encodeWords(words));
    }

    function challengeForScalars(bytes memory state, uint256 tauX, uint256 mu, uint256 t)
        internal
        pure
        returns (bytes memory nextState, uint256 challenge)
    {
        uint256[] memory words = new uint256[](3);
        words[0] = tauX;
        words[1] = mu;
        words[2] = t;
        (nextState, challenge,) = RangeTranscriptV3.challengeStep(state, U_TAG, RangeTranscriptV3.encodeWords(words));
    }

    function challengeForRound(
        bytes memory state,
        uint256 roundIndex,
        Bn254.Point memory left,
        Bn254.Point memory right
    ) internal pure returns (bytes memory nextState, uint256 challenge) {
        uint256[] memory words = new uint256[](5);
        words[0] = roundIndex;
        words[1] = left.x;
        words[2] = left.y;
        words[3] = right.x;
        words[4] = right.y;
        (nextState, challenge,) =
            RangeTranscriptV3.challengeStep(state, ROUND_TAG, RangeTranscriptV3.encodeWords(words));
    }

    function inverseScaleGenerators(uint256[BIT_WIDTH] memory scales)
        internal
        view
        returns (Bn254.Point[BIT_WIDTH] memory scaled)
    {
        for (uint256 index = 0; index < BIT_WIDTH; index++) {
            scaled[index] = hs[index].mul(scales[index].inv());
        }
    }

    function sumScalars(uint256[BIT_WIDTH] memory scalars) internal pure returns (uint256 sum) {
        for (uint256 index = 0; index < BIT_WIDTH; index++) {
            sum = sum.add(scalars[index]);
        }
    }

    function sumPoints(Bn254.Point[BIT_WIDTH] memory points) internal view returns (Bn254.Point memory sum) {
        sum = points[0];
        for (uint256 index = 1; index < BIT_WIDTH; index++) {
            sum = sum.add(points[index]);
        }
    }

    function commit(Bn254.Point[BIT_WIDTH] memory points, uint256[BIT_WIDTH] memory scalars)
        internal
        view
        returns (Bn254.Point memory commitment)
    {
        commitment = points[0].mul(scalars[0]);
        for (uint256 index = 1; index < BIT_WIDTH; index++) {
            commitment = commitment.add(points[index].mul(scalars[index]));
        }
    }

    function commitReversed(Bn254.Point[BIT_WIDTH] memory points, uint256[BIT_WIDTH] memory scalars)
        internal
        view
        returns (Bn254.Point memory commitment)
    {
        commitment = points[0].mul(scalars[BIT_WIDTH - 1]);
        for (uint256 index = 1; index < BIT_WIDTH; index++) {
            commitment = commitment.add(points[index].mul(scalars[BIT_WIDTH - 1 - index]));
        }
    }

    function powers(uint256 base) internal pure returns (uint256[BIT_WIDTH] memory powersOfBase) {
        powersOfBase[0] = 1;
        for (uint256 index = 1; index < BIT_WIDTH; index++) {
            powersOfBase[index] = powersOfBase[index - 1].mul(base);
        }
    }
}
