import edu.stanford.cs.crypto.efficientct.circuit.groups.BouncyCastleECPoint;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class RevisedRangeProof {
    byte[] operationId;
    BigInteger outputIndex;
    BouncyCastleECPoint rangeCommitment;
    BouncyCastleECPoint aPoint;
    BouncyCastleECPoint sPoint;
    BouncyCastleECPoint t1Point;
    BouncyCastleECPoint t2Point;
    BigInteger tauX;
    BigInteger mu;
    BigInteger t;
    BigInteger a;
    BigInteger b;
    final List<BouncyCastleECPoint> leftPoints = new ArrayList<>();
    final List<BouncyCastleECPoint> rightPoints = new ArrayList<>();

    Map<String, Object> encode() {
        Map<String, Object> encoded = new LinkedHashMap<>();
        encoded.put("operationId", RevisedProtocol.hex(operationId));
        encoded.put("outputIndex", outputIndex.toString());
        List<String> coordinates = new ArrayList<>();
        for (BouncyCastleECPoint point : Arrays.asList(rangeCommitment, aPoint, sPoint, t1Point, t2Point)) coordinates.addAll(RevisedProtocol.coordinates(point));
        encoded.put("coords", coordinates);
        encoded.put("scalars", List.of(tauX.toString(), mu.toString(), t.toString(), a.toString(), b.toString()));
        encoded.put("ls", splitCoordinates(leftPoints));
        encoded.put("rs", splitCoordinates(rightPoints));
        return encoded;
    }

    static List<String> splitCoordinates(List<BouncyCastleECPoint> points) {
        List<String> abscissas = new ArrayList<>();
        List<String> ordinates = new ArrayList<>();
        for (BouncyCastleECPoint point : points) {
            List<String> pair = RevisedProtocol.coordinates(point);
            abscissas.add(pair.get(0));
            ordinates.add(pair.get(1));
        }
        abscissas.addAll(ordinates);
        return abscissas;
    }
}
