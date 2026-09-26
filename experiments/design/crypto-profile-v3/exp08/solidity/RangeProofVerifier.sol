pragma solidity 0.4.19;

import "./alt_bn128.sol";
import "./Transcript.sol";

contract RangeProofVerifier {
    using alt_bn128 for uint256;
    using alt_bn128 for alt_bn128.G1Point;

    uint256 public constant BIT_WIDTH = 64;
    uint256 public constant ROUNDS = 6;
    uint256 internal constant TWO_TO_64_MINUS_ONE = 18446744073709551615;
    bytes32 internal constant PARAMETERS_TAG = keccak256("ecu/bp/parameters/v3");
    bytes32 internal constant Y_TAG = keccak256("ecu/bp/y/v3");
    bytes32 internal constant Z_TAG = keccak256("ecu/bp/z/v3");
    bytes32 internal constant X_TAG = keccak256("ecu/bp/x/v3");
    bytes32 internal constant U_TAG = keccak256("ecu/bp/u/v3");
    bytes32 internal constant ROUND_TAG = keccak256("ecu/bp/round/v3");

    alt_bn128.G1Point[BIT_WIDTH] public gs;
    alt_bn128.G1Point[BIT_WIDTH] public hs;
    alt_bn128.G1Point public valueBase;
    alt_bn128.G1Point public blindingBase;

    struct RangeProof {
        alt_bn128.G1Point commitmentA;
        alt_bn128.G1Point commitmentS;
        alt_bn128.G1Point[2] coefficientCommitments;
        uint256 tauX;
        uint256 mu;
        uint256 t;
        alt_bn128.G1Point[ROUNDS] left;
        alt_bn128.G1Point[ROUNDS] right;
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
        alt_bn128.G1Point innerBase;
        alt_bn128.G1Point innerCommitment;
    }

    struct InnerBoard {
        bytes transcriptState;
        alt_bn128.G1Point commitment;
        uint256 challenge;
        uint256 inverseChallenge;
        uint256[ROUNDS] challenges;
        uint256[BIT_WIDTH] weights;
        alt_bn128.G1Point foldedG;
        alt_bn128.G1Point foldedH;
        alt_bn128.G1Point expectedCommitment;
    }

    function RangeProofVerifier(uint256[4] base, uint256[128] gsCoords, uint256[128] hsCoords) public {
        require(calculateParametersHash(base, gsCoords, hsCoords) == Transcript.expectedParametersHash());
        valueBase = alt_bn128.G1Point(base[0], base[1]);
        blindingBase = alt_bn128.G1Point(base[2], base[3]);
        require(alt_bn128.isAllowedPoint(valueBase, false));
        require(alt_bn128.isAllowedPoint(blindingBase, false));
        for (uint256 index = 0; index < BIT_WIDTH; index++) {
            gs[index] = alt_bn128.G1Point(gsCoords[index], gsCoords[BIT_WIDTH + index]);
            hs[index] = alt_bn128.G1Point(hsCoords[index], hsCoords[BIT_WIDTH + index]);
            require(alt_bn128.isAllowedPoint(gs[index], false));
            require(alt_bn128.isAllowedPoint(hs[index], false));
        }
        // Pairwise comparisons are omitted because the fixed digest binds one vector,
        // whose 130 distinct points are checked off chain (EXP-07A vectors.json).
        // This relies on Keccak collision resistance, not an arbitrary caller digest.
    }

    function parametersHash() public pure returns (bytes32) {
        return Transcript.expectedParametersHash();
    }

    function verify(bytes32 operationId, uint256 outputIndex, uint256[10] coords, uint256[5] scalars, uint256[] ls, uint256[] rs) external view returns (bool) {
        RangeProof memory proof = decodeProof(coords, scalars, ls, rs);
        alt_bn128.G1Point memory inputCommitment = alt_bn128.G1Point(coords[0], coords[1]);
        return verifyRange(inputCommitment, proof, Transcript.initialPrefix(operationId, outputIndex, inputCommitment));
    }

    function calculateParametersHash(uint256[4] base, uint256[128] gsCoords, uint256[128] hsCoords) internal pure returns (bytes32 digest) {
        uint256[262] memory words;
        words[0] = uint256(PARAMETERS_TAG);
        words[1] = BIT_WIDTH;
        for (uint256 index = 0; index < 4; index++) words[2 + index] = base[index];
        for (index = 0; index < BIT_WIDTH; index++) {
            words[6 + 2 * index] = gsCoords[index];
            words[7 + 2 * index] = gsCoords[BIT_WIDTH + index];
            words[134 + 2 * index] = hsCoords[index];
            words[135 + 2 * index] = hsCoords[BIT_WIDTH + index];
        }
        assembly { digest := keccak256(words, 8384) }
    }

    function decodeProof(uint256[10] coords, uint256[5] scalars, uint256[] ls, uint256[] rs) internal pure returns (RangeProof proof) {
        require(ls.length == 2 * ROUNDS && rs.length == 2 * ROUNDS);
        require(alt_bn128.isAllowedPoint(alt_bn128.G1Point(coords[0], coords[1]), true));
        for (uint256 index = 0; index < 5; index++) require(alt_bn128.isCanonicalScalar(scalars[index]));
        proof.commitmentA = alt_bn128.G1Point(coords[2], coords[3]);
        proof.commitmentS = alt_bn128.G1Point(coords[4], coords[5]);
        proof.coefficientCommitments[0] = alt_bn128.G1Point(coords[6], coords[7]);
        proof.coefficientCommitments[1] = alt_bn128.G1Point(coords[8], coords[9]);
        require(alt_bn128.isAllowedPoint(proof.commitmentA, true));
        require(alt_bn128.isAllowedPoint(proof.commitmentS, true));
        require(alt_bn128.isAllowedPoint(proof.coefficientCommitments[0], true));
        require(alt_bn128.isAllowedPoint(proof.coefficientCommitments[1], true));
        proof.tauX = scalars[0];
        proof.mu = scalars[1];
        proof.t = scalars[2];
        proof.scalarA = scalars[3];
        proof.scalarB = scalars[4];
        for (index = 0; index < ROUNDS; index++) {
            proof.left[index] = alt_bn128.G1Point(ls[index], ls[ROUNDS + index]);
            proof.right[index] = alt_bn128.G1Point(rs[index], rs[ROUNDS + index]);
            require(alt_bn128.isAllowedPoint(proof.left[index], true));
            require(alt_bn128.isAllowedPoint(proof.right[index], true));
        }
    }

    function verifyRange(alt_bn128.G1Point inputCommitment, RangeProof proof, bytes memory initialState) internal view returns (bool) {
        RangeBoard memory board;
        (board.transcriptState, board.y) = challengeForPoints(initialState, Y_TAG, proof.commitmentA, proof.commitmentS);
        board.powersOfY = powers(board.y);
        (board.transcriptState, board.z,) = Transcript.challengeStep(board.transcriptState, Z_TAG, new bytes(0));
        board.zSquared = board.z.mul(board.z);
        board.zCubed = board.zSquared.mul(board.z);
        (board.transcriptState, board.x) = challengeForPoints(board.transcriptState, X_TAG, proof.coefficientCommitments[0], proof.coefficientCommitments[1]);
        board.delta = sumScalars(board.powersOfY).mul(board.z.sub(board.zSquared)).sub(board.zCubed.mul(TWO_TO_64_MINUS_ONE));
        if (!satisfiesPolynomialCommitment(inputCommitment, proof, board)) return false;
        (board.transcriptState, board.uChallenge) = challengeForScalars(board.transcriptState, proof.tauX, proof.mu, proof.t);
        board.innerBase = valueBase.mul(board.uChallenge);
        alt_bn128.G1Point[BIT_WIDTH] memory hPrimes = inverseScaleGenerators(board.powersOfY);
        board.innerCommitment = deriveInnerCommitment(proof, board, hPrimes);
        board.transcriptState = Transcript.enterInner(board.transcriptState, board.innerCommitment, board.innerBase);
        return verifyInner(board.transcriptState, board.innerCommitment, board.innerBase, hPrimes, proof);
    }

    function satisfiesPolynomialCommitment(alt_bn128.G1Point inputCommitment, RangeProof proof, RangeBoard board) internal view returns (bool) {
        alt_bn128.G1Point memory expected = valueBase.mul(proof.t).add(blindingBase.mul(proof.tauX));
        alt_bn128.G1Point memory actual = proof.coefficientCommitments[0].mul(board.x);
        actual = actual.add(proof.coefficientCommitments[1].mul(board.x.mul(board.x)));
        actual = actual.add(inputCommitment.mul(board.zSquared));
        actual = actual.add(valueBase.mul(board.delta));
        return actual.eq(expected);
    }

    function deriveInnerCommitment(RangeProof proof, RangeBoard board, alt_bn128.G1Point[BIT_WIDTH] hPrimes) internal view returns (alt_bn128.G1Point commitment) {
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

    function verifyInner(bytes memory state, alt_bn128.G1Point commitment, alt_bn128.G1Point innerBase, alt_bn128.G1Point[BIT_WIDTH] hPrimes, RangeProof proof) internal view returns (bool) {
        InnerBoard memory board;
        board.transcriptState = state;
        board.commitment = commitment;
        for (uint256 roundIndex = 0; roundIndex < ROUNDS; roundIndex++) {
            (board.transcriptState, board.challenge) = challengeForRound(board.transcriptState, roundIndex, proof.left[roundIndex], proof.right[roundIndex]);
            board.inverseChallenge = board.challenge.inv();
            board.commitment = proof.left[roundIndex].mul(board.challenge.mul(board.challenge))
                .add(proof.right[roundIndex].mul(board.inverseChallenge.mul(board.inverseChallenge)))
                .add(board.commitment);
            board.challenges[roundIndex] = board.challenge;
        }
        board.weights = calculateInnerWeights(board.challenges);
        board.foldedG = commit(gs, board.weights);
        board.foldedH = commitReversed(hPrimes, board.weights);
        board.expectedCommitment = board.foldedG.mul(proof.scalarA)
            .add(board.foldedH.mul(proof.scalarB))
            .add(innerBase.mul(proof.scalarA.mul(proof.scalarB)));
        return board.expectedCommitment.eq(board.commitment);
    }

    function calculateInnerWeights(uint256[ROUNDS] challenges) internal view returns (uint256[BIT_WIDTH] weights) {
        uint256 product = 1;
        for (uint256 roundIndex = 0; roundIndex < ROUNDS; roundIndex++) product = product.mul(challenges[roundIndex]);
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

    function challengeForPoints(bytes memory state, bytes32 stageTag, alt_bn128.G1Point first, alt_bn128.G1Point second) internal pure returns (bytes memory nextState, uint256 challenge) {
        uint256[] memory words = new uint256[](4);
        words[0] = first.X;
        words[1] = first.Y;
        words[2] = second.X;
        words[3] = second.Y;
        (nextState, challenge,) = Transcript.challengeStep(state, stageTag, Transcript.encodeWords(words));
    }

    function challengeForScalars(bytes memory state, uint256 tauX, uint256 mu, uint256 t) internal pure returns (bytes memory nextState, uint256 challenge) {
        uint256[] memory words = new uint256[](3);
        words[0] = tauX;
        words[1] = mu;
        words[2] = t;
        (nextState, challenge,) = Transcript.challengeStep(state, U_TAG, Transcript.encodeWords(words));
    }

    function challengeForRound(bytes memory state, uint256 roundIndex, alt_bn128.G1Point left, alt_bn128.G1Point right) internal pure returns (bytes memory nextState, uint256 challenge) {
        uint256[] memory words = new uint256[](5);
        words[0] = roundIndex;
        words[1] = left.X;
        words[2] = left.Y;
        words[3] = right.X;
        words[4] = right.Y;
        (nextState, challenge,) = Transcript.challengeStep(state, ROUND_TAG, Transcript.encodeWords(words));
    }

    function inverseScaleGenerators(uint256[BIT_WIDTH] scales) internal view returns (alt_bn128.G1Point[BIT_WIDTH] scaled) {
        for (uint256 index = 0; index < BIT_WIDTH; index++) scaled[index] = hs[index].mul(scales[index].inv());
    }

    function sumScalars(uint256[BIT_WIDTH] scalars) internal pure returns (uint256 sum) {
        for (uint256 index = 0; index < BIT_WIDTH; index++) sum = sum.add(scalars[index]);
    }

    function sumPoints(alt_bn128.G1Point[BIT_WIDTH] points) internal view returns (alt_bn128.G1Point sum) {
        sum = points[0];
        for (uint256 index = 1; index < BIT_WIDTH; index++) sum = sum.add(points[index]);
    }

    function commit(alt_bn128.G1Point[BIT_WIDTH] points, uint256[BIT_WIDTH] scalars) internal view returns (alt_bn128.G1Point commitment) {
        commitment = points[0].mul(scalars[0]);
        for (uint256 index = 1; index < BIT_WIDTH; index++) commitment = commitment.add(points[index].mul(scalars[index]));
    }

    function commitReversed(alt_bn128.G1Point[BIT_WIDTH] points, uint256[BIT_WIDTH] scalars) internal view returns (alt_bn128.G1Point commitment) {
        commitment = points[0].mul(scalars[BIT_WIDTH - 1]);
        for (uint256 index = 1; index < BIT_WIDTH; index++) commitment = commitment.add(points[index].mul(scalars[BIT_WIDTH - 1 - index]));
    }

    function powers(uint256 base) internal pure returns (uint256[BIT_WIDTH] powersOfBase) {
        powersOfBase[0] = 1;
        for (uint256 index = 1; index < BIT_WIDTH; index++) powersOfBase[index] = powersOfBase[index - 1].mul(base);
    }
}
