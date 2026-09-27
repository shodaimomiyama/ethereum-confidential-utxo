// Generated from packages/ethereum/generated/uniswap-payment-v1.json; ABI SHA-256: e58930d5e379f9c22786ae7263c04bba36c639f74e27cfe0e379d54e7f817991
import type { Abi } from 'viem';

export const adapterAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "pool_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "router02_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "factory_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "weth_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "dUSD_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "pair_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "receive",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "dUSD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "factory",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isPaymentExecuted",
    "inputs": [
      {
        "name": "paymentId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pair",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pay",
    "inputs": [
      {
        "name": "withdrawal",
        "type": "tuple",
        "internalType": "struct PoolTypes.OperationRequest",
        "components": [
          {
            "name": "kind",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "salt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "inputIds",
            "type": "bytes32[]",
            "internalType": "bytes32[]"
          },
          {
            "name": "outputs",
            "type": "tuple[]",
            "internalType": "struct PoolTypes.Output[]",
            "components": [
              {
                "name": "owner",
                "type": "address",
                "internalType": "address"
              },
              {
                "name": "Cx",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "Cy",
                "type": "uint256",
                "internalType": "uint256"
              },
              {
                "name": "receiptFormat",
                "type": "uint8",
                "internalType": "uint8"
              },
              {
                "name": "packet",
                "type": "bytes",
                "internalType": "bytes"
              }
            ]
          },
          {
            "name": "d",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "w",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "destination",
            "type": "address",
            "internalType": "address"
          }
        ]
      },
      {
        "name": "balanceProof",
        "type": "tuple",
        "internalType": "struct PoolTypes.BalanceProof",
        "components": [
          {
            "name": "Rx",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "Ry",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "s",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "rangeProofs",
        "type": "tuple[]",
        "internalType": "struct PoolTypes.RangeProofV3[]",
        "components": [
          {
            "name": "coords",
            "type": "uint256[10]",
            "internalType": "uint256[10]"
          },
          {
            "name": "scalars",
            "type": "uint256[5]",
            "internalType": "uint256[5]"
          },
          {
            "name": "ls",
            "type": "uint256[]",
            "internalType": "uint256[]"
          },
          {
            "name": "rs",
            "type": "uint256[]",
            "internalType": "uint256[]"
          }
        ]
      },
      {
        "name": "poolSignature",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "terms",
        "type": "tuple",
        "internalType": "struct UniswapPaymentAdapter.PaymentTerms",
        "components": [
          {
            "name": "operationId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "ethAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "minAmountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "paymentSignature",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "paymentId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "amountOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "paymentDigest",
    "inputs": [
      {
        "name": "terms",
        "type": "tuple",
        "internalType": "struct UniswapPaymentAdapter.PaymentTerms",
        "components": [
          {
            "name": "operationId",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "ethAmount",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "token",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "minAmountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pool",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "router02",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "weth",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "PaymentSucceeded",
    "inputs": [
      {
        "name": "paymentId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "operationId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "ethAmount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "minAmountOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "recipient",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "deadline",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "amountOut",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "DeliveryMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidConfiguration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidPayment",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidPaymentSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PaymentAlreadyExecuted",
    "inputs": [
      {
        "name": "paymentId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ]
  },
  {
    "type": "error",
    "name": "PaymentExpired",
    "inputs": [
      {
        "name": "deadline",
        "type": "uint64",
        "internalType": "uint64"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrantPayment",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SwapAccountingMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnexpectedEthReceipt",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsupportedRecipient",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnsupportedToken",
    "inputs": []
  }
] as const satisfies Abi;
