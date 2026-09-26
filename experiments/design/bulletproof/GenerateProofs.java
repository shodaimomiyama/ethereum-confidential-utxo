import com.google.gson.GsonBuilder;
import edu.stanford.cs.crypto.efficientct.GeneratorParams;
import edu.stanford.cs.crypto.efficientct.VerificationFailedException;
import edu.stanford.cs.crypto.efficientct.circuit.groups.BN128Group;
import edu.stanford.cs.crypto.efficientct.circuit.groups.BouncyCastleECPoint;
import edu.stanford.cs.crypto.efficientct.commitments.PeddersenCommitment;
import edu.stanford.cs.crypto.efficientct.rangeproof.RangeProof;
import edu.stanford.cs.crypto.efficientct.rangeproof.RangeProofProver;
import edu.stanford.cs.crypto.efficientct.rangeproof.RangeProofVerifier;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.bouncycastle.math.ec.ECPoint;

public class GenerateProofs {
    private static List<String> encodePoint(BouncyCastleECPoint point) {
        ECPoint normalized = point.getPoint().normalize();
        if (normalized.isInfinity()) {
            return Arrays.asList("0", "0");
        }
        return Arrays.asList(normalized.getAffineXCoord().toBigInteger().toString(), normalized.getAffineYCoord().toBigInteger().toString());
    }

    private static List<String> encodeSplitCoordinates(Iterable<BouncyCastleECPoint> points) {
        List<String> coordinates = new ArrayList<>();
        List<String> ordinates = new ArrayList<>();
        for (BouncyCastleECPoint point : points) {
            List<String> encoded = encodePoint(point);
            coordinates.add(encoded.get(0));
            ordinates.add(encoded.get(1));
        }
        coordinates.addAll(ordinates);
        return coordinates;
    }

    private static Map<String, Object> generateProof(GeneratorParams<BouncyCastleECPoint> parameters, BigInteger value, boolean expectedValid) {
        Map<String, Object> observation = new LinkedHashMap<>();
        observation.put("label", "value-" + value);
        observation.put("value", value.toString());
        observation.put("expectedValid", expectedValid);
        BigInteger blinding = BigInteger.valueOf(42);
        observation.put("testOnlyCommitmentBlinding", blinding.toString());
        BouncyCastleECPoint commitment = parameters.getBase().commit(value, blinding);
        long started = System.nanoTime();
        try {
            RangeProof<BouncyCastleECPoint> proof = new RangeProofProver<BouncyCastleECPoint>().generateProof(parameters, commitment, new PeddersenCommitment<>(parameters.getBase(), value, blinding));
            observation.put("proverMilliseconds", (System.nanoTime() - started) / 1e6);
            List<String> coordinates = new ArrayList<>();
            coordinates.addAll(encodePoint(commitment));
            coordinates.addAll(encodePoint(proof.getaI()));
            coordinates.addAll(encodePoint(proof.getS()));
            for (BouncyCastleECPoint polynomialCommitment : proof.gettCommits()) {
                coordinates.addAll(encodePoint(polynomialCommitment));
            }
            observation.put("coords", coordinates);
            observation.put("scalars", Arrays.asList(proof.getTauX().toString(), proof.getMu().toString(), proof.getT().toString(), proof.getProductProof().getA().toString(), proof.getProductProof().getB().toString()));
            observation.put("ls", encodeSplitCoordinates(proof.getProductProof().getL()));
            observation.put("rs", encodeSplitCoordinates(proof.getProductProof().getR()));
            long verificationStarted = System.nanoTime();
            try {
                new RangeProofVerifier<BouncyCastleECPoint>().verify(parameters, commitment, proof);
                observation.put("javaVerifierAccepted", true);
            } catch (VerificationFailedException rejected) {
                observation.put("javaVerifierAccepted", false);
                observation.put("javaVerifierRejection", rejected.getMessage());
            }
            observation.put("javaVerifierMilliseconds", (System.nanoTime() - verificationStarted) / 1e6);
        } catch (Exception failure) {
            observation.put("proverError", failure.getClass().getName() + ": " + failure.getMessage());
        }
        return observation;
    }

    public static void main(String[] arguments) throws Exception {
        int bitWidth = Integer.parseInt(arguments[0]);
        if (bitWidth != 4 && bitWidth != 64) throw new IllegalArgumentException("Only the manifest dimensions are allowed");
        long parametersStarted = System.nanoTime();
        GeneratorParams<BouncyCastleECPoint> parameters = GeneratorParams.generateParams(bitWidth, new BN128Group());
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("bitWidth", bitWidth);
        output.put("parameterGenerationMilliseconds", (System.nanoTime() - parametersStarted) / 1e6);
        output.put("randomness", "Commitment blinding is the public test-only constant 42; prover randomness uses the unmodified upstream SecureRandom");
        Map<String, Object> encodedParameters = new LinkedHashMap<>();
        List<String> baseCoordinates = new ArrayList<>(encodePoint(parameters.getBase().g));
        baseCoordinates.addAll(encodePoint(parameters.getBase().h));
        encodedParameters.put("base", baseCoordinates);
        encodedParameters.put("gs", encodeSplitCoordinates(parameters.getVectorBase().getGs()));
        encodedParameters.put("hs", encodeSplitCoordinates(parameters.getVectorBase().getHs()));
        encodedParameters.put("innerH", encodePoint(parameters.getBase().h));
        output.put("parameters", encodedParameters);
        List<Map<String, Object>> proofs = new ArrayList<>();
        BigInteger limit = BigInteger.ONE.shiftLeft(bitWidth);
        for (BigInteger value : Arrays.asList(BigInteger.ZERO, BigInteger.ONE, limit.subtract(BigInteger.ONE), BigInteger.valueOf(-1), limit)) {
            proofs.add(generateProof(parameters, value, value.signum() >= 0 && value.compareTo(limit) < 0));
        }
        output.put("proofs", proofs);
        Files.writeString(Path.of(arguments[1]), new GsonBuilder().setPrettyPrinting().create().toJson(output) + "\n");
        for (Map<String, Object> proof : proofs) {
            System.out.println(proof.get("label") + ": generated=" + !proof.containsKey("proverError") + ", javaVerifierAccepted=" + proof.get("javaVerifierAccepted"));
        }
    }
}
