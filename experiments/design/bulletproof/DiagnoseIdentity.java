import com.google.gson.GsonBuilder;
import edu.stanford.cs.crypto.efficientct.GeneratorParams;
import edu.stanford.cs.crypto.efficientct.circuit.groups.BN128Group;
import edu.stanford.cs.crypto.efficientct.circuit.groups.BouncyCastleECPoint;
import edu.stanford.cs.crypto.efficientct.commitments.PeddersenCommitment;
import edu.stanford.cs.crypto.efficientct.rangeproof.RangeProofProver;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Arrays;
import java.util.stream.Collectors;

public class DiagnoseIdentity {
    public static void main(String[] arguments) throws Exception {
        GeneratorParams<BouncyCastleECPoint> parameters = GeneratorParams.generateParams(64, new BN128Group());
        BouncyCastleECPoint commitment = parameters.getBase().commit(BigInteger.ZERO, BigInteger.ZERO);
        Map<String, Object> observation = new LinkedHashMap<>();
        observation.put("value", "0");
        observation.put("blinding", "0");
        observation.put("isIdentity", commitment.getPoint().isInfinity());
        observation.put("evmSubmitted", false);
        try {
            new RangeProofProver<BouncyCastleECPoint>().generateProof(parameters, commitment, new PeddersenCommitment<>(parameters.getBase(), BigInteger.ZERO, BigInteger.ZERO));
            observation.put("proverGenerated", true);
        } catch (Exception failure) {
            observation.put("proverGenerated", false);
            observation.put("exception", failure.toString());
            observation.put("stackTrace", Arrays.stream(failure.getStackTrace()).map(StackTraceElement::toString).collect(Collectors.toList()));
        }
        Files.writeString(Path.of(arguments[0]), new GsonBuilder().setPrettyPrinting().create().toJson(observation) + "\n");
        System.out.println("Identity commitment: proverGenerated=" + observation.get("proverGenerated") + "; EVM not submitted");
    }
}
