// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

library PoolTypes {
    struct Output {
        address owner;
        uint256 Cx;
        uint256 Cy;
        uint8 receiptFormat;
        bytes packet;
    }

    struct OperationRequest {
        uint8 kind;
        address owner;
        bytes32 salt;
        bytes32[] inputIds;
        Output[] outputs;
        uint256 d;
        uint256 w;
        address destination;
    }

    struct BalanceProof {
        uint256 Rx;
        uint256 Ry;
        uint256 s;
    }

    struct RangeProofV3 {
        uint256[10] coords;
        uint256[5] scalars;
        uint256[] ls;
        uint256[] rs;
    }
}
