import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import edu.stanford.cs.crypto.efficientct.circuit.groups.BN128Group;
import edu.stanford.cs.crypto.efficientct.circuit.groups.BouncyCastleECPoint;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bouncycastle.jcajce.provider.digest.Keccak;
import org.bouncycastle.math.ec.ECPoint;

final class RevisedProtocol {
    static final int BITS = 64;
    static final int ROUNDS = 6;
    static final BigInteger Q = BN128Group.ORDER;
    static final BigInteger P = BN128Group.P;
    static final BigInteger UINT256_LIMIT = BigInteger.ONE.shiftLeft(256);
    static final BN128Group GROUP = new BN128Group();
    private static final SecureRandom RANDOM = new SecureRandom();

    static byte[] concatenate(byte[]... parts) {
        ByteArrayOutputStream joined = new ByteArrayOutputStream();
        for (byte[] part : parts) joined.writeBytes(part);
        return joined.toByteArray();
    }

    static byte[] hash(byte[]... parts) {
        return new Keccak.Digest256().digest(concatenate(parts));
    }

    static byte[] word(BigInteger integer) {
        if (integer.signum() < 0 || integer.compareTo(UINT256_LIMIT) >= 0) throw new IllegalArgumentException("Integer outside uint256");
        byte[] signed = integer.toByteArray();
        byte[] encoded = new byte[32];
        int count = Math.min(signed.length, 32);
        System.arraycopy(signed, signed.length - count, encoded, 32 - count, count);
        return encoded;
    }

    static byte[] word(long integer) {
        return word(BigInteger.valueOf(integer));
    }

    static String hex(byte[] bytes) {
        return "0x" + HexFormat.of().formatHex(bytes);
    }

    static byte[] decodeHex32(String encoded) {
        if (!encoded.matches("0x[0-9a-fA-F]{64}")) throw new IllegalArgumentException("Expected bytes32");
        return HexFormat.of().parseHex(encoded.substring(2));
    }

    static BigInteger scalar(BigInteger integer) {
        if (integer.signum() < 0 || integer.compareTo(Q) >= 0) throw new IllegalArgumentException("Noncanonical scalar");
        return integer;
    }

    static boolean acceptsChallenge(BigInteger candidate) {
        return candidate.signum() > 0 && candidate.compareTo(Q) < 0;
    }

    static boolean acceptsSecretScalar(BigInteger candidate) {
        return candidate.signum() >= 0 && candidate.compareTo(Q) < 0;
    }

    static BigInteger randomScalar() {
        for (int attempt = 0; attempt < 256; attempt++) {
            BigInteger candidate = new BigInteger(256, RANDOM);
            if (acceptsSecretScalar(candidate)) return candidate;
        }
        throw new RetryProof("Secret scalar sampling exhausted 256 candidates");
    }

    static BigInteger mod(BigInteger integer) {
        return integer.mod(Q);
    }

    static BouncyCastleECPoint multiply(BouncyCastleECPoint point, BigInteger exponent) {
        return point.multiply(mod(exponent));
    }

    static List<String> coordinates(BouncyCastleECPoint point) {
        ECPoint normalized = point.getPoint().normalize();
        if (normalized.isInfinity()) return List.of("0", "0");
        return List.of(normalized.getAffineXCoord().toBigInteger().toString(), normalized.getAffineYCoord().toBigInteger().toString());
    }

    static byte[] encodePoint(BouncyCastleECPoint point) {
        List<String> pair = coordinates(point);
        return concatenate(word(new BigInteger(pair.get(0))), word(new BigInteger(pair.get(1))));
    }

    static BouncyCastleECPoint decodePoint(BigInteger x, BigInteger y, boolean allowIdentity) {
        if (x.signum() < 0 || y.signum() < 0 || x.compareTo(P) >= 0 || y.compareTo(P) >= 0) throw new IllegalArgumentException("Noncanonical point coordinate");
        if (x.signum() == 0 && y.signum() == 0) {
            if (!allowIdentity) throw new IllegalArgumentException("Disallowed identity point");
            return GROUP.zero();
        }
        if (!y.multiply(y).mod(P).equals(x.pow(3).add(BigInteger.valueOf(3)).mod(P))) throw new IllegalArgumentException("Point is not on curve");
        return new BouncyCastleECPoint(GROUP.getCurve().validatePoint(x, y));
    }

    static BouncyCastleECPoint decodePoint(List<String> pair, boolean allowIdentity) {
        if (pair.size() != 2) throw new IllegalArgumentException("Point must have two coordinates");
        return decodePoint(new BigInteger(pair.get(0)), new BigInteger(pair.get(1)), allowIdentity);
    }

    static void requireInternalNonidentity(BouncyCastleECPoint point) {
        if (point.getPoint().isInfinity()) throw new RetryProof("Internal proof point is identity");
    }

    static BouncyCastleECPoint commit(BouncyCastleECPoint[] generators, BigInteger[] exponents) {
        if (generators.length != exponents.length) throw new IllegalArgumentException("Vector dimensions differ");
        BouncyCastleECPoint sum = GROUP.zero();
        for (int index = 0; index < generators.length; index++) sum = sum.add(multiply(generators[index], exponents[index]));
        return sum;
    }

    static BigInteger innerProduct(BigInteger[] left, BigInteger[] right) {
        if (left.length != right.length) throw new IllegalArgumentException("Vector dimensions differ");
        BigInteger sum = BigInteger.ZERO;
        for (int index = 0; index < left.length; index++) sum = mod(sum.add(left[index].multiply(right[index])));
        return sum;
    }

    static final class RetryProof extends RuntimeException {
        RetryProof(String reason) { super(reason); }
    }

    static final class Parameters {
        final BouncyCastleECPoint valueBase;
        final BouncyCastleECPoint blindingBase;
        final BouncyCastleECPoint[] generators;
        final BouncyCastleECPoint[] hidingGenerators;
        final byte[] parametersHash;
        final Map<String, byte[]> tags;
        final JsonObject encoded;

        Parameters(Path profilePath, Path parametersPath) throws Exception {
            JsonObject profile = new JsonParser().parse(Files.readString(profilePath)).getAsJsonObject();
            if (profile.get("bitWidth").getAsInt() != BITS || profile.get("rounds").getAsInt() != ROUNDS || profile.get("aggregationCount").getAsInt() != 1) throw new IllegalArgumentException("Unsupported profile dimensions");
            if (!new BigInteger(profile.get("scalarModulus").getAsString()).equals(Q) || !new BigInteger(profile.get("coordinateModulus").getAsString()).equals(P)) throw new IllegalArgumentException("Curve modulus mismatch");
            tags = new LinkedHashMap<>();
            for (Map.Entry<String, com.google.gson.JsonElement> entry : profile.getAsJsonObject("tags").entrySet()) tags.put(entry.getKey(), hash(entry.getValue().getAsString().getBytes(StandardCharsets.UTF_8)));
            encoded = new JsonParser().parse(Files.readString(parametersPath)).getAsJsonObject();
            JsonArray base = encoded.getAsJsonArray("base");
            if (base.size() != 4) throw new IllegalArgumentException("Base dimension mismatch");
            valueBase = decodePoint(base.get(0).getAsBigInteger(), base.get(1).getAsBigInteger(), false);
            blindingBase = decodePoint(base.get(2).getAsBigInteger(), base.get(3).getAsBigInteger(), false);
            generators = decodeGenerators(encoded.getAsJsonArray("gs"));
            hidingGenerators = decodeGenerators(encoded.getAsJsonArray("hs"));
            Set<String> distinct = new HashSet<>();
            List<BouncyCastleECPoint> points = new ArrayList<>();
            points.add(valueBase);
            points.add(blindingBase);
            points.addAll(Arrays.asList(generators));
            points.addAll(Arrays.asList(hidingGenerators));
            for (BouncyCastleECPoint point : points) {
                if (!distinct.add(hex(encodePoint(point)))) throw new IllegalArgumentException("Duplicate public generator");
            }
            ByteArrayOutputStream preimage = new ByteArrayOutputStream();
            preimage.writeBytes(tags.get("parameters"));
            preimage.writeBytes(word(BITS));
            for (BouncyCastleECPoint point : points) preimage.writeBytes(encodePoint(point));
            parametersHash = hash(preimage.toByteArray());
            if (!hex(parametersHash).equals(profile.get("expectedParametersHash").getAsString()) || !hex(parametersHash).equals(encoded.get("expectedParametersHash").getAsString())) throw new IllegalArgumentException("Parameter hash mismatch");
        }

        private static BouncyCastleECPoint[] decodeGenerators(JsonArray coordinates) {
            if (coordinates.size() != 2 * BITS) throw new IllegalArgumentException("Generator dimension mismatch");
            BouncyCastleECPoint[] points = new BouncyCastleECPoint[BITS];
            for (int index = 0; index < BITS; index++) points[index] = decodePoint(coordinates.get(index).getAsBigInteger(), coordinates.get(BITS + index).getAsBigInteger(), false);
            return points;
        }
    }

    static final class Transcript {
        private final Parameters parameters;
        private byte[] state;
        private byte[] prefix;
        final Map<String, Object> trace = new LinkedHashMap<>();
        private final List<Map<String, Object>> stages = new ArrayList<>();

        Transcript(Parameters parameters, byte[] operationId, BigInteger outputIndex, BouncyCastleECPoint rangeCommitment) {
            if (operationId.length != 32) throw new IllegalArgumentException("Operation ID must be bytes32");
            this.parameters = parameters;
            prefix = concatenate(parameters.tags.get("protocol"), word(BITS), word(1), parameters.parametersHash, operationId, parameters.tags.get("role"), word(outputIndex), encodePoint(rangeCommitment));
            state = hash(prefix);
            trace.put("initialState", hex(state));
            trace.put("stages", stages);
        }

        BigInteger challenge(String stage, byte[] payload) {
            byte[] previous = state;
            byte[] segment = concatenate(parameters.tags.get(stage), word(payload.length), payload);
            byte[] inputState = hash(prefix, segment);
            List<String> candidates = new ArrayList<>();
            for (int counter = 0; counter < 256; counter++) {
                byte[] digest = hash(inputState, parameters.tags.get("candidate"), word(counter));
                candidates.add(hex(digest));
                BigInteger challenge = new BigInteger(1, digest);
                if (acceptsChallenge(challenge)) {
                    prefix = concatenate(prefix, segment, parameters.tags.get("accepted"), word(challenge));
                    state = hash(prefix);
                    Map<String, Object> step = new LinkedHashMap<>();
                    step.put("stage", stage);
                    step.put("previousState", hex(previous));
                    step.put("payloadHex", hex(payload));
                    step.put("inputState", hex(inputState));
                    step.put("counter", counter);
                    step.put("candidates", candidates);
                    step.put("challenge", challenge.toString());
                    step.put("nextState", hex(state));
                    stages.add(step);
                    trace.put("finalState", hex(state));
                    return challenge;
                }
            }
            throw new RetryProof("No acceptable challenge within 256 candidates");
        }

        void bindInnerProduct(BouncyCastleECPoint commitment, BouncyCastleECPoint uPoint) {
            byte[] previous = state;
            byte[] payload = concatenate(word(BITS), encodePoint(commitment), encodePoint(uPoint));
            prefix = concatenate(prefix, parameters.tags.get("inner"), word(payload.length), payload);
            state = hash(prefix);
            Map<String, Object> step = new LinkedHashMap<>();
            step.put("stage", "inner");
            step.put("previousState", hex(previous));
            step.put("payloadHex", hex(payload));
            step.put("P", coordinates(commitment));
            step.put("uPoint", coordinates(uPoint));
            step.put("nextState", hex(state));
            stages.add(step);
            trace.put("finalState", hex(state));
        }

        BigInteger round(int round, BouncyCastleECPoint left, BouncyCastleECPoint right) {
            BigInteger challenge = challenge("round", concatenate(word(round), encodePoint(left), encodePoint(right)));
            stages.get(stages.size() - 1).put("roundIndex", round);
            return challenge;
        }
    }
}
