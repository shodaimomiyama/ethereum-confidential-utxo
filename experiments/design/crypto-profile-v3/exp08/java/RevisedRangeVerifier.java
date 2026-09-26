import edu.stanford.cs.crypto.efficientct.circuit.groups.BouncyCastleECPoint;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class RevisedRangeVerifier {
    static final class Verification {
        boolean accepted;
        String reason;
        Map<String, Object> transcriptTrace;
    }

    Verification verify(RevisedProtocol.Parameters parameters, Map<String, Object> encoded) {
        Verification verification = new Verification();
        try {
            List<String> coordinates = strings(encoded.get("coords"), 10);
            List<String> scalars = strings(encoded.get("scalars"), 5);
            List<String> leftCoordinates = strings(encoded.get("ls"), 12);
            List<String> rightCoordinates = strings(encoded.get("rs"), 12);
            BouncyCastleECPoint rangeCommitment = RevisedProtocol.decodePoint(coordinates.subList(0, 2), true);
            BouncyCastleECPoint aPoint = RevisedProtocol.decodePoint(coordinates.subList(2, 4), true);
            BouncyCastleECPoint sPoint = RevisedProtocol.decodePoint(coordinates.subList(4, 6), true);
            BouncyCastleECPoint t1Point = RevisedProtocol.decodePoint(coordinates.subList(6, 8), true);
            BouncyCastleECPoint t2Point = RevisedProtocol.decodePoint(coordinates.subList(8, 10), true);
            BigInteger tauX = RevisedProtocol.scalar(new BigInteger(scalars.get(0)));
            BigInteger mu = RevisedProtocol.scalar(new BigInteger(scalars.get(1)));
            BigInteger t = RevisedProtocol.scalar(new BigInteger(scalars.get(2)));
            BigInteger a = RevisedProtocol.scalar(new BigInteger(scalars.get(3)));
            BigInteger b = RevisedProtocol.scalar(new BigInteger(scalars.get(4)));
            BouncyCastleECPoint[] leftPoints = decodeInnerPoints(leftCoordinates);
            BouncyCastleECPoint[] rightPoints = decodeInnerPoints(rightCoordinates);
            byte[] operationId = RevisedProtocol.decodeHex32(String.valueOf(encoded.get("operationId")));
            BigInteger outputIndex = new BigInteger(String.valueOf(encoded.get("outputIndex")));
            RevisedProtocol.word(outputIndex);
            RevisedProtocol.Transcript transcript = new RevisedProtocol.Transcript(parameters, operationId, outputIndex, rangeCommitment);
            verification.transcriptTrace = transcript.trace;
            BigInteger y = transcript.challenge("y", RevisedProtocol.concatenate(RevisedProtocol.encodePoint(aPoint), RevisedProtocol.encodePoint(sPoint)));
            BigInteger z = transcript.challenge("z", new byte[0]);
            BigInteger x = transcript.challenge("x", RevisedProtocol.concatenate(RevisedProtocol.encodePoint(t1Point), RevisedProtocol.encodePoint(t2Point)));
            BigInteger zSquared = RevisedProtocol.mod(z.multiply(z));
            BigInteger zCubed = RevisedProtocol.mod(zSquared.multiply(z));
            BigInteger[] yPowers = new BigInteger[RevisedProtocol.BITS];
            BigInteger yPower = BigInteger.ONE;
            BigInteger sumYPowers = BigInteger.ZERO;
            for (int index = 0; index < RevisedProtocol.BITS; index++) {
                yPowers[index] = yPower;
                sumYPowers = RevisedProtocol.mod(sumYPowers.add(yPower));
                yPower = RevisedProtocol.mod(yPower.multiply(y));
            }
            BigInteger delta = RevisedProtocol.mod(z.subtract(zSquared).multiply(sumYPowers).subtract(zCubed.multiply(BigInteger.ONE.shiftLeft(RevisedProtocol.BITS).subtract(BigInteger.ONE))));
            BouncyCastleECPoint polynomialLeft = RevisedProtocol.multiply(parameters.valueBase, t).add(RevisedProtocol.multiply(parameters.blindingBase, tauX));
            BouncyCastleECPoint polynomialRight = RevisedProtocol.multiply(rangeCommitment, zSquared)
                .add(RevisedProtocol.multiply(parameters.valueBase, delta))
                .add(RevisedProtocol.multiply(t1Point, x))
                .add(RevisedProtocol.multiply(t2Point, x.multiply(x)));
            if (!polynomialLeft.equals(polynomialRight)) {
                verification.reason = "Polynomial identity rejected";
                return verification;
            }
            BigInteger uChallenge = transcript.challenge("u", RevisedProtocol.concatenate(RevisedProtocol.word(tauX), RevisedProtocol.word(mu), RevisedProtocol.word(t)));
            BouncyCastleECPoint uPoint = RevisedProtocol.multiply(parameters.valueBase, uChallenge);
            BouncyCastleECPoint[] generators = parameters.generators.clone();
            BouncyCastleECPoint[] hidingGenerators = new BouncyCastleECPoint[RevisedProtocol.BITS];
            BouncyCastleECPoint commitment = aPoint.add(RevisedProtocol.multiply(sPoint, x)).subtract(RevisedProtocol.multiply(parameters.blindingBase, mu)).add(RevisedProtocol.multiply(uPoint, t));
            for (int index = 0; index < RevisedProtocol.BITS; index++) {
                hidingGenerators[index] = RevisedProtocol.multiply(parameters.hidingGenerators[index], yPowers[index].modInverse(RevisedProtocol.Q));
                BigInteger hidingExponent = RevisedProtocol.mod(yPowers[index].multiply(z).add(zSquared.multiply(BigInteger.ONE.shiftLeft(index))));
                commitment = commitment.subtract(RevisedProtocol.multiply(generators[index], z)).add(RevisedProtocol.multiply(hidingGenerators[index], hidingExponent));
            }
            transcript.bindInnerProduct(commitment, uPoint);
            for (int round = 0; round < RevisedProtocol.ROUNDS; round++) {
                BigInteger challenge = transcript.round(round, leftPoints[round], rightPoints[round]);
                BigInteger inverse = challenge.modInverse(RevisedProtocol.Q);
                commitment = commitment.add(RevisedProtocol.multiply(leftPoints[round], challenge.multiply(challenge))).add(RevisedProtocol.multiply(rightPoints[round], inverse.multiply(inverse)));
                int half = generators.length / 2;
                BouncyCastleECPoint[] foldedGenerators = new BouncyCastleECPoint[half];
                BouncyCastleECPoint[] foldedHidingGenerators = new BouncyCastleECPoint[half];
                for (int index = 0; index < half; index++) {
                    foldedGenerators[index] = RevisedProtocol.multiply(generators[index], inverse).add(RevisedProtocol.multiply(generators[half + index], challenge));
                    foldedHidingGenerators[index] = RevisedProtocol.multiply(hidingGenerators[index], challenge).add(RevisedProtocol.multiply(hidingGenerators[half + index], inverse));
                }
                generators = foldedGenerators;
                hidingGenerators = foldedHidingGenerators;
            }
            BouncyCastleECPoint terminalCommitment = RevisedProtocol.multiply(generators[0], a).add(RevisedProtocol.multiply(hidingGenerators[0], b)).add(RevisedProtocol.multiply(uPoint, a.multiply(b)));
            verification.accepted = terminalCommitment.equals(commitment);
            verification.reason = verification.accepted ? "Accepted" : "Inner-product equation rejected";
        } catch (IllegalArgumentException | ArithmeticException | RevisedProtocol.RetryProof rejection) {
            verification.accepted = false;
            verification.reason = rejection.getClass().getSimpleName() + ": " + rejection.getMessage();
        }
        return verification;
    }

    private static List<String> strings(Object encoded, int length) {
        if (!(encoded instanceof List<?> values) || values.size() != length) throw new IllegalArgumentException("Array length must be " + length);
        List<String> strings = new ArrayList<>();
        for (Object value : values) strings.add(String.valueOf(value));
        return strings;
    }

    private static BouncyCastleECPoint[] decodeInnerPoints(List<String> coordinates) {
        BouncyCastleECPoint[] points = new BouncyCastleECPoint[RevisedProtocol.ROUNDS];
        for (int index = 0; index < RevisedProtocol.ROUNDS; index++) points[index] = RevisedProtocol.decodePoint(new BigInteger(coordinates.get(index)), new BigInteger(coordinates.get(RevisedProtocol.ROUNDS + index)), true);
        return points;
    }
}
