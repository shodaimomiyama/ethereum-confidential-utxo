// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {PoolTypes} from "./PoolTypes.sol";

library PoolBinding {
    bytes32 internal constant INPUTS_TAG = keccak256("ecu/inputs/v1");
    bytes32 internal constant OUTPUT_TAG = keccak256("ecu/output/v1");
    bytes32 internal constant OUTPUTS_TAG = keccak256("ecu/outputs/v1");
    bytes32 internal constant OP_TAG = keccak256("ecu/operation/v1");
    bytes32 internal constant OUTPUT_ID_TAG = keccak256("ecu/output-id/v1");
    bytes32 internal constant DOMAIN_TYPE =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant AUTH_TYPE =
        keccak256("OperationAuthorization(bytes32 operationId,address owner,uint8 authScheme,uint8 authVersion)");

    function operationId(PoolTypes.OperationRequest calldata request, uint256 chainId, address pool)
        internal
        pure
        returns (bytes32)
    {
        bytes32 inputsHash = keccak256(abi.encode(INPUTS_TAG, request.inputIds));
        bytes32[] memory hashes = new bytes32[](request.outputs.length);
        for (uint256 i; i < hashes.length; ++i) {
            PoolTypes.Output calldata output = request.outputs[i];
            hashes[i] = keccak256(
                abi.encode(
                    OUTPUT_TAG, i, output.owner, output.Cx, output.Cy, output.receiptFormat, keccak256(output.packet)
                )
            );
        }
        bytes32 outputsHash = keccak256(abi.encode(OUTPUTS_TAG, hashes));
        bytes memory prefix = abi.encode(OP_TAG, chainId, pool, request.kind, request.owner, request.salt);
        bytes memory suffix = abi.encode(inputsHash, outputsHash, request.d, request.w, request.destination);
        return keccak256(bytes.concat(prefix, suffix));
    }

    function outputId(bytes32 id, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encode(OUTPUT_ID_TAG, id, index));
    }

    function authorizationDigest(bytes32 id, address owner, uint256 chainId, address pool)
        internal
        pure
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPE, keccak256("Ethereum Confidential UTXO"), keccak256("1"), chainId, pool)
        );
        bytes32 auth = keccak256(abi.encode(AUTH_TYPE, id, owner, uint8(1), uint8(1)));
        return keccak256(abi.encodePacked(hex"1901", domain, auth));
    }
}
