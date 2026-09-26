import edu.stanford.cs.crypto.efficientct.circuit.groups.BouncyCastleECPoint;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class RevisedRangeProver {
    static final int MAXIMUM_ATTEMPTS = 1;
    private static final BigInteger ZERO = BigInteger.ZERO;
    private static final BigInteger ONE = BigInteger.ONE;

    static final class GeneratedProof {
        RevisedRangeProof proof;
        BouncyCastleECPoint originalCommitment;
        Map<String, Object> transcriptTrace;
        int attempts;
        List<String> retryReasons;
    }

    GeneratedProof generate(RevisedProtocol.Parameters parameters, byte[] operationId, BigInteger outputIndex, BigInteger originalAmount, BigInteger blinding, boolean forcePolynomialBlindingsZero) {
        RevisedProtocol.word(originalAmount);
        RevisedProtocol.scalar(blinding);
        List<String> retryReasons = new ArrayList<>();
        for (int attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt++) {
            try {
                GeneratedProof generated = generateAttempt(parameters, operationId, outputIndex, originalAmount, blinding, forcePolynomialBlindingsZero);
                generated.attempts = attempt + 1;
                generated.retryReasons = retryReasons;
                return generated;
            } catch (RevisedProtocol.RetryProof retry) {
                retryReasons.add(retry.getMessage());
            }
        }
        throw new IllegalStateException("Proof generation exhausted " + MAXIMUM_ATTEMPTS + " attempts: " + retryReasons);
    }

    private GeneratedProof generateAttempt(RevisedProtocol.Parameters parameters, byte[] operationId, BigInteger outputIndex, BigInteger originalAmount, BigInteger blinding, boolean forcePolynomialBlindingsZero) {
        RevisedRangeProof proof = new RevisedRangeProof();
        proof.operationId = operationId.clone();
        proof.outputIndex = outputIndex;
        BouncyCastleECPoint originalCommitment = RevisedProtocol.multiply(parameters.valueBase, originalAmount).add(RevisedProtocol.multiply(parameters.blindingBase, blinding));
        proof.rangeCommitment = originalCommitment.subtract(parameters.valueBase);
        BigInteger rangeValue = originalAmount.subtract(ONE);
        BigInteger[] bitVector = new BigInteger[RevisedProtocol.BITS];
        BigInteger[] shiftedBitVector = new BigInteger[RevisedProtocol.BITS];
        BigInteger[] leftMask = new BigInteger[RevisedProtocol.BITS];
        BigInteger[] rightMask = new BigInteger[RevisedProtocol.BITS];
        for (int index = 0; index < RevisedProtocol.BITS; index++) {
            bitVector[index] = rangeValue.testBit(index) ? ONE : ZERO;
            shiftedBitVector[index] = RevisedProtocol.mod(bitVector[index].subtract(ONE));
            leftMask[index] = RevisedProtocol.randomScalar();
            rightMask[index] = RevisedProtocol.randomScalar();
        }
        BigInteger alpha = RevisedProtocol.randomScalar();
        BigInteger rho = RevisedProtocol.randomScalar();
        proof.aPoint = RevisedProtocol.commit(parameters.generators, bitVector).add(RevisedProtocol.commit(parameters.hidingGenerators, shiftedBitVector)).add(RevisedProtocol.multiply(parameters.blindingBase, alpha));
        proof.sPoint = RevisedProtocol.commit(parameters.generators, leftMask).add(RevisedProtocol.commit(parameters.hidingGenerators, rightMask)).add(RevisedProtocol.multiply(parameters.blindingBase, rho));
        RevisedProtocol.Transcript transcript = new RevisedProtocol.Transcript(parameters, operationId, outputIndex, proof.rangeCommitment);
        BigInteger y = transcript.challenge("y", RevisedProtocol.concatenate(RevisedProtocol.encodePoint(proof.aPoint), RevisedProtocol.encodePoint(proof.sPoint)));
        BigInteger z = transcript.challenge("z", new byte[0]);
        BigInteger zSquared = RevisedProtocol.mod(z.multiply(z));
        BigInteger[] leftConstant = new BigInteger[RevisedProtocol.BITS];
        BigInteger[] rightConstant = new BigInteger[RevisedProtocol.BITS];
        BigInteger[] rightLinear = new BigInteger[RevisedProtocol.BITS];
        BigInteger[] yPowers = new BigInteger[RevisedProtocol.BITS];
        BigInteger yPower = ONE;
        for (int index = 0; index < RevisedProtocol.BITS; index++) {
            yPowers[index] = yPower;
            leftConstant[index] = RevisedProtocol.mod(bitVector[index].subtract(z));
            rightConstant[index] = RevisedProtocol.mod(yPower.multiply(shiftedBitVector[index].add(z)).add(zSquared.multiply(ONE.shiftLeft(index))));
            rightLinear[index] = RevisedProtocol.mod(yPower.multiply(rightMask[index]));
            yPower = RevisedProtocol.mod(yPower.multiply(y));
        }
        BigInteger t1 = RevisedProtocol.mod(RevisedProtocol.innerProduct(leftMask, rightConstant).add(RevisedProtocol.innerProduct(leftConstant, rightLinear)));
        BigInteger t2 = RevisedProtocol.innerProduct(leftMask, rightLinear);
        BigInteger tau1 = forcePolynomialBlindingsZero ? ZERO : RevisedProtocol.randomScalar();
        BigInteger tau2 = forcePolynomialBlindingsZero ? ZERO : RevisedProtocol.randomScalar();
        proof.t1Point = RevisedProtocol.multiply(parameters.valueBase, t1).add(RevisedProtocol.multiply(parameters.blindingBase, tau1));
        proof.t2Point = RevisedProtocol.multiply(parameters.valueBase, t2).add(RevisedProtocol.multiply(parameters.blindingBase, tau2));
        BigInteger x = transcript.challenge("x", RevisedProtocol.concatenate(RevisedProtocol.encodePoint(proof.t1Point), RevisedProtocol.encodePoint(proof.t2Point)));
        BigInteger[] leftEvaluated = new BigInteger[RevisedProtocol.BITS];
        BigInteger[] rightEvaluated = new BigInteger[RevisedProtocol.BITS];
        BouncyCastleECPoint[] adjustedHidingGenerators = new BouncyCastleECPoint[RevisedProtocol.BITS];
        for (int index = 0; index < RevisedProtocol.BITS; index++) {
            leftEvaluated[index] = RevisedProtocol.mod(leftConstant[index].add(leftMask[index].multiply(x)));
            rightEvaluated[index] = RevisedProtocol.mod(rightConstant[index].add(rightLinear[index].multiply(x)));
            adjustedHidingGenerators[index] = RevisedProtocol.multiply(parameters.hidingGenerators[index], yPowers[index].modInverse(RevisedProtocol.Q));
        }
        proof.t = RevisedProtocol.innerProduct(leftEvaluated, rightEvaluated);
        proof.tauX = RevisedProtocol.mod(zSquared.multiply(blinding).add(tau1.multiply(x)).add(tau2.multiply(x).multiply(x)));
        proof.mu = RevisedProtocol.mod(alpha.add(rho.multiply(x)));
        BigInteger uChallenge = transcript.challenge("u", RevisedProtocol.concatenate(RevisedProtocol.word(proof.tauX), RevisedProtocol.word(proof.mu), RevisedProtocol.word(proof.t)));
        BouncyCastleECPoint uPoint = RevisedProtocol.multiply(parameters.valueBase, uChallenge);
        BouncyCastleECPoint innerCommitment = RevisedProtocol.commit(parameters.generators, leftEvaluated).add(RevisedProtocol.commit(adjustedHidingGenerators, rightEvaluated)).add(RevisedProtocol.multiply(uPoint, proof.t));
        transcript.bindInnerProduct(innerCommitment, uPoint);
        generateInnerProduct(parameters.generators, adjustedHidingGenerators, uPoint, innerCommitment, leftEvaluated, rightEvaluated, transcript, proof);
        GeneratedProof generated = new GeneratedProof();
        generated.proof = proof;
        generated.originalCommitment = originalCommitment;
        generated.transcriptTrace = transcript.trace;
        return generated;
    }

    private void generateInnerProduct(BouncyCastleECPoint[] initialGenerators, BouncyCastleECPoint[] initialHidingGenerators, BouncyCastleECPoint uPoint, BouncyCastleECPoint initialCommitment, BigInteger[] initialLeft, BigInteger[] initialRight, RevisedProtocol.Transcript transcript, RevisedRangeProof proof) {
        BouncyCastleECPoint[] generators = initialGenerators.clone();
        BouncyCastleECPoint[] hidingGenerators = initialHidingGenerators.clone();
        BigInteger[] left = initialLeft.clone();
        BigInteger[] right = initialRight.clone();
        BouncyCastleECPoint commitment = initialCommitment;
        for (int round = 0; round < RevisedProtocol.ROUNDS; round++) {
            int half = left.length / 2;
            BigInteger[] leftLow = Arrays.copyOfRange(left, 0, half);
            BigInteger[] leftHigh = Arrays.copyOfRange(left, half, left.length);
            BigInteger[] rightLow = Arrays.copyOfRange(right, 0, half);
            BigInteger[] rightHigh = Arrays.copyOfRange(right, half, right.length);
            BouncyCastleECPoint leftPoint = RevisedProtocol.commit(Arrays.copyOfRange(generators, half, generators.length), leftLow)
                .add(RevisedProtocol.commit(Arrays.copyOfRange(hidingGenerators, 0, half), rightHigh))
                .add(RevisedProtocol.multiply(uPoint, RevisedProtocol.innerProduct(leftLow, rightHigh)));
            BouncyCastleECPoint rightPoint = RevisedProtocol.commit(Arrays.copyOfRange(generators, 0, half), leftHigh)
                .add(RevisedProtocol.commit(Arrays.copyOfRange(hidingGenerators, half, hidingGenerators.length), rightLow))
                .add(RevisedProtocol.multiply(uPoint, RevisedProtocol.innerProduct(leftHigh, rightLow)));
            proof.leftPoints.add(leftPoint);
            proof.rightPoints.add(rightPoint);
            BigInteger challenge = transcript.round(round, leftPoint, rightPoint);
            BigInteger inverse = challenge.modInverse(RevisedProtocol.Q);
            BouncyCastleECPoint[] foldedGenerators = new BouncyCastleECPoint[half];
            BouncyCastleECPoint[] foldedHidingGenerators = new BouncyCastleECPoint[half];
            BigInteger[] foldedLeft = new BigInteger[half];
            BigInteger[] foldedRight = new BigInteger[half];
            for (int index = 0; index < half; index++) {
                foldedGenerators[index] = RevisedProtocol.multiply(generators[index], inverse).add(RevisedProtocol.multiply(generators[half + index], challenge));
                foldedHidingGenerators[index] = RevisedProtocol.multiply(hidingGenerators[index], challenge).add(RevisedProtocol.multiply(hidingGenerators[half + index], inverse));
                foldedLeft[index] = RevisedProtocol.mod(leftLow[index].multiply(challenge).add(leftHigh[index].multiply(inverse)));
                foldedRight[index] = RevisedProtocol.mod(rightLow[index].multiply(inverse).add(rightHigh[index].multiply(challenge)));
            }
            commitment = RevisedProtocol.multiply(leftPoint, challenge.multiply(challenge)).add(commitment).add(RevisedProtocol.multiply(rightPoint, inverse.multiply(inverse)));
            generators = foldedGenerators;
            hidingGenerators = foldedHidingGenerators;
            left = foldedLeft;
            right = foldedRight;
        }
        proof.a = RevisedProtocol.scalar(left[0]);
        proof.b = RevisedProtocol.scalar(right[0]);
    }
}
