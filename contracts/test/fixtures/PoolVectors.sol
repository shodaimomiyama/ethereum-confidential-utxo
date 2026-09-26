// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface VmPoolVectors {
    function readFile(string calldata path) external returns (string memory);
    function parseJson(string calldata json, string calldata key) external pure returns (bytes memory);
}

library PoolVectors {
    address internal constant FIXED_POOL = 0x1111111111111111111111111111111111111111;
    VmPoolVectors internal constant VM = VmPoolVectors(address(uint160(uint256(keccak256("hevm cheat code")))));

    function json() internal returns (string memory) {
        return VM.readFile("test/fixtures/pool-calldata.json");
    }

    function calldataFor(string memory name) internal returns (bytes memory) {
        return abi.decode(VM.parseJson(json(), string.concat(".", name, ".calldata")), (bytes));
    }

    function operationId(string memory name) internal returns (bytes32) {
        return abi.decode(VM.parseJson(json(), string.concat(".", name, ".operationId")), (bytes32));
    }

    function outputId(string memory name, uint256 index) internal returns (bytes32) {
        bytes32[] memory ids = abi.decode(VM.parseJson(json(), string.concat(".", name, ".outputIds")), (bytes32[]));
        return ids[index];
    }
}
