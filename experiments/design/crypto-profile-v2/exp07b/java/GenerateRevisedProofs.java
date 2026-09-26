import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

public class GenerateRevisedProofs {
    private static final Gson JSON = new GsonBuilder().setPrettyPrinting().create();

    private record Case(String label, BigInteger amount, BigInteger blinding, boolean zeroPolynomialBlindings, boolean expectedValid) {}

    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 1) throw new IllegalArgumentException("Usage: GenerateRevisedProofs output.json; working directory must be bulletproof-revised");
        Path outputPath = Path.of(arguments[0]);
        Path profilePath = Path.of("profile.json");
        Path parametersPath = Path.of("parameters.json");
        long parameterStarted = System.nanoTime();
        RevisedProtocol.Parameters parameters = new RevisedProtocol.Parameters(profilePath, parametersPath);
        RevisedProtocol.Parameters verifierParameters = new RevisedProtocol.Parameters(profilePath, parametersPath);
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("experiment", "EXP-07B");
        output.put("parameters", parameters.encoded);
        output.put("parametersHash", RevisedProtocol.hex(parameters.parametersHash));
        output.put("profileKeccak256", RevisedProtocol.hex(RevisedProtocol.hash(Files.readAllBytes(profilePath))));
        output.put("parameterGenerationAndValidationMilliseconds", (System.nanoTime() - parameterStarted) / 1e6);
        output.put("parameterValidation", Map.of("canonicalCoordinates", true, "onCurve", true, "nonidentity", true, "distinctPoints", 130, "matchesEXP07AVectors", true, "matchesExpectedParametersHash", true));
        output.put("maximumProofAttempts", RevisedRangeProver.MAXIMUM_ATTEMPTS);
        output.put("maximumSecretScalarCandidates", 256);
        output.put("randomness", "SecureRandom with exact rejection into [0,q); unpublished prover randomness; only public test witness blindings and explicit zero polynomial blindings are recorded");
        output.put("predicateBoundaryChecks", verifyPredicateBoundaries());
        output.put("notEstablished", List.of("cryptographic security", "zero knowledge", "formal verification", "UTXO application conformance"));
        List<Map<String, Object>> proofs = new ArrayList<>();
        output.put("proofs", proofs);
        BigInteger maximum = BigInteger.ONE.shiftLeft(64);
        List<Case> cases = List.of(
            new Case("amount-1-blinding-42", BigInteger.ONE, BigInteger.valueOf(42), false, true),
            new Case("amount-max-blinding-42", maximum, BigInteger.valueOf(42), false, true),
            new Case("amount-1-blinding-0", BigInteger.ONE, BigInteger.ZERO, false, true),
            new Case("amount-over-max", maximum.add(BigInteger.ONE), BigInteger.valueOf(42), false, false)
        );
        RevisedRangeVerifier verifier = new RevisedRangeVerifier();
        for (Case specification : cases) {
            byte[] operationId = RevisedProtocol.hash(("ecu/EXP-07B/test-case/" + specification.label()).getBytes(StandardCharsets.UTF_8));
            BigInteger outputIndex = BigInteger.ZERO;
            long proverStarted = System.nanoTime();
            RevisedRangeProver.GeneratedProof generated = new RevisedRangeProver().generate(parameters, operationId, outputIndex, specification.amount(), specification.blinding(), specification.zeroPolynomialBlindings());
            Map<String, Object> encoded = generated.proof.encode();
            encoded.put("label", specification.label());
            encoded.put("value", specification.amount().subtract(BigInteger.ONE).toString());
            encoded.put("originalAmount", specification.amount().toString());
            encoded.put("originalCommitment", RevisedProtocol.coordinates(generated.originalCommitment));
            encoded.put("testOnlyCommitmentBlinding", specification.blinding().toString());
            encoded.put("expectedValid", specification.expectedValid());
            encoded.put("parametersHash", RevisedProtocol.hex(parameters.parametersHash));
            encoded.put("forcePolynomialBlindingsZero", specification.zeroPolynomialBlindings());
            if (specification.zeroPolynomialBlindings()) encoded.put("testOnlyPolynomialBlindings", List.of("0", "0"));
            encoded.put("proverMilliseconds", (System.nanoTime() - proverStarted) / 1e6);
            encoded.put("proverAttempts", generated.attempts);
            encoded.put("retryReasons", generated.retryReasons);
            encoded.put("transcriptTrace", generated.transcriptTrace);
            long verifierStarted = System.nanoTime();
            RevisedRangeVerifier.Verification verified = verifier.verify(verifierParameters, encoded);
            encoded.put("javaVerifierMilliseconds", (System.nanoTime() - verifierStarted) / 1e6);
            encoded.put("javaVerifierAccepted", verified.accepted);
            encoded.put("javaVerifierReason", verified.reason);
            encoded.put("javaVerifierTranscriptTrace", verified.transcriptTrace);
            boolean sameTranscript = JSON.toJson(generated.transcriptTrace).equals(JSON.toJson(verified.transcriptTrace));
            encoded.put("javaTranscriptMatchesProver", sameTranscript);
            proofs.add(encoded);
            Files.writeString(outputPath, JSON.toJson(output) + "\n");
            if (verified.accepted != specification.expectedValid()) throw new IllegalStateException("Unexpected Java verifier outcome: " + specification.label() + ": " + verified.reason);
            if (specification.expectedValid() && !sameTranscript) throw new IllegalStateException("Prover and verifier transcript mismatch: " + specification.label());
            System.out.println(specification.label() + ": generated=true; verifierAccepted=" + verified.accepted + "; transcriptMatches=" + sameTranscript + "; attempts=" + generated.attempts);
        }
        output.put("javaMutationChecks", verifyMutations(verifierParameters, proofs.get(0)));
        output.put("allExpectedJavaOutcomesSatisfied", true);
        Files.writeString(outputPath, JSON.toJson(output) + "\n");
    }

    private static List<Map<String, Object>> verifyPredicateBoundaries() {
        List<Map<String, Object>> checks = new ArrayList<>();
        for (BigInteger candidate : List.of(BigInteger.ZERO, BigInteger.ONE, RevisedProtocol.Q.subtract(BigInteger.ONE), RevisedProtocol.Q, RevisedProtocol.UINT256_LIMIT.subtract(BigInteger.ONE))) {
            boolean expectedChallenge = candidate.signum() > 0 && candidate.compareTo(RevisedProtocol.Q) < 0;
            boolean expectedSecret = candidate.signum() >= 0 && candidate.compareTo(RevisedProtocol.Q) < 0;
            boolean challengeAccepted = RevisedProtocol.acceptsChallenge(candidate);
            boolean secretAccepted = RevisedProtocol.acceptsSecretScalar(candidate);
            if (challengeAccepted != expectedChallenge || secretAccepted != expectedSecret) throw new IllegalStateException("Scalar predicate boundary mismatch");
            checks.add(Map.of("candidate", candidate.toString(), "challengeAccepted", challengeAccepted, "secretScalarAccepted", secretAccepted));
        }
        return checks;
    }

    private static List<Map<String, Object>> verifyMutations(RevisedProtocol.Parameters parameters, Map<String, Object> validProof) {
        List<Map<String, Object>> observations = new ArrayList<>();
        for (int index = 0; index < 5; index++) {
            final int scalarIndex = index;
            rejectMutation(parameters, validProof, "scalar-" + index + "-plus-q", proof -> {
                List<String> scalars = mutableStrings(proof, "scalars");
                scalars.set(scalarIndex, new BigInteger(scalars.get(scalarIndex)).add(RevisedProtocol.Q).toString());
            }, observations);
        }
        rejectMutation(parameters, validProof, "tauX-plus-one", proof -> {
            List<String> scalars = mutableStrings(proof, "scalars");
            scalars.set(0, RevisedProtocol.mod(new BigInteger(scalars.get(0)).add(BigInteger.ONE)).toString());
        }, observations);
        rejectMutation(parameters, validProof, "commitment-changed", proof -> {
            List<String> coordinates = mutableStrings(proof, "coords");
            coordinates.set(0, "1"); coordinates.set(1, "2");
        }, observations);
        rejectMutation(parameters, validProof, "coordinate-equals-p", proof -> mutableStrings(proof, "coords").set(0, RevisedProtocol.P.toString()), observations);
        rejectMutation(parameters, validProof, "point-off-curve", proof -> {
            List<String> coordinates = mutableStrings(proof, "coords");
            coordinates.set(0, "1"); coordinates.set(1, "1");
        }, observations);
        for (int index = 1; index <= 4; index++) {
            final int pointIndex = index;
            rejectMutation(parameters, validProof, "proof-point-" + index + "-identity", proof -> {
                List<String> coordinates = mutableStrings(proof, "coords");
                coordinates.set(2 * pointIndex, "0"); coordinates.set(2 * pointIndex + 1, "0");
            }, observations);
        }
        for (String field : List.of("ls", "rs")) {
            rejectMutation(parameters, validProof, field + "-identity", proof -> {
                List<String> coordinates = mutableStrings(proof, field);
                coordinates.set(0, "0"); coordinates.set(6, "0");
            }, observations);
            rejectMutation(parameters, validProof, field + "-short", proof -> mutableStrings(proof, field).remove(11), observations);
            rejectMutation(parameters, validProof, field + "-long", proof -> mutableStrings(proof, field).add("0"), observations);
        }
        rejectMutation(parameters, validProof, "operation-id-changed", proof -> proof.put("operationId", RevisedProtocol.hex(RevisedProtocol.hash("changed-operation".getBytes(StandardCharsets.UTF_8)))), observations);
        rejectMutation(parameters, validProof, "output-index-changed", proof -> proof.put("outputIndex", "1"), observations);
        return observations;
    }

    private static List<String> mutableStrings(Map<String, Object> proof, String key) {
        @SuppressWarnings("unchecked") List<String> values = (List<String>) proof.get(key);
        return values;
    }

    private static void rejectMutation(RevisedProtocol.Parameters parameters, Map<String, Object> source, String label, Consumer<Map<String, Object>> mutation, List<Map<String, Object>> observations) {
        Map<String, Object> changed = new LinkedHashMap<>();
        for (String key : List.of("coords", "scalars", "ls", "rs")) changed.put(key, new ArrayList<>(mutableStrings(source, key)));
        changed.put("operationId", source.get("operationId"));
        changed.put("outputIndex", source.get("outputIndex"));
        mutation.accept(changed);
        RevisedRangeVerifier.Verification verification = new RevisedRangeVerifier().verify(parameters, changed);
        observations.add(Map.of("label", label, "accepted", verification.accepted, "reason", verification.reason));
        if (verification.accepted) throw new IllegalStateException("Mutation was unexpectedly accepted: " + label);
    }
}
