import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
runtime = (ROOT / "runtime.hex").read_text().strip()
assert len(runtime) == 2 * 8467
source = '''pragma solidity 0.4.19;

contract Vm {
    function etch(address target, bytes code) external;
    function expectRevert() external;
}

contract IRangeProofVerifier {
    function verify(bytes32 operationId, uint256 outputIndex, uint256[10] coords,
        uint256[5] scalars, uint256[] ls, uint256[] rs) external view returns (bool);
}

contract V3OptimizedVerifierRejectionTest {
    Vm constant vm = Vm(address(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D));
    IRangeProofVerifier constant verifier = IRangeProofVerifier(address(0x000000000000000000000000000000000000bEEF));

    function setUp() public {
        vm.etch(address(verifier), hex"''' + runtime + '''");
    }

    function test_rejectsWrongLeftLength(uint256 x, uint256 y, uint256 scalar) public {
        uint256[10] memory coords;
        uint256[5] memory scalars;
        coords[0] = x;
        coords[1] = y;
        scalars[0] = scalar;
        uint256[] memory ls = new uint256[](0);
        uint256[] memory rs = new uint256[](12);
        vm.expectRevert();
        verifier.verify(bytes32(0), 0, coords, scalars, ls, rs);
    }
}
'''
test_dir = ROOT / "test"
test_dir.mkdir(exist_ok=True)
path = test_dir / "V3OptimizedVerifierRejection.t.sol"
path.write_text(source)
(ROOT / "harness-result.json").write_text(json.dumps({
    "sourceSha256": hashlib.sha256(source.encode()).hexdigest(),
    "runtimeBytes": len(runtime) // 2,
    "runtimeHexEmbeddedOnce": source.count(runtime) == 1,
    "runtimeFrom": "runtime.hex",
    "setUpSeparateFromTest": True
}, indent=2) + "\n")
