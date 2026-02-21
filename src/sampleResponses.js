/**
 * Sample API Response - Demo Output
 * 
 * This file shows what a typical /analyze response looks like
 * when debugging a failed Arbitrum retryable ticket transaction.
 */

export const SAMPLE_RESPONSE_LOW_GAS = {
  txHash: '0x1234567890abcdef...',
  foundOn: 'L1',
  timeline: {
    actions: [
      {
        id: 1,
        timestamp: null,
        action: 'L1_TX_SUBMITTED',
        status: 'confirmed',
        isTerminal: false,
        color: '#10b981',
        details: {
          txHash: '0x1234567890abcdef...',
          blockNumber: '19500000',
          gasUsed: '150000'
        }
      },
      {
        id: 2,
        timestamp: null,
        action: 'RETRYABLE_CREATED',
        status: 'confirmed',
        isTerminal: false,
        color: '#10b981',
        details: {
          ticketId: '12345',
          from: '0x1234567890abcdef...',
          to: '0xabcdef1234567890...',
          maxGas: '100000',
          gasPriceBid: '5000000000',
          submissionCost: '10000000000000000'
        }
      },
      {
        id: 3,
        timestamp: null,
        action: 'AUTO_REDEEM_ATTEMPT',
        status: 'unknown',
        isTerminal: false,
        color: '#6b7280',
        details: {
          ticketId: '12345',
          reason: 'Retryable auto-redeem occurs within ~1 hour of creation'
        }
      },
      {
        id: 4,
        timestamp: null,
        action: 'FAILURE',
        status: 'failed',
        isTerminal: true,
        color: '#ef4444',
        details: {
          location: 'L1',
          reason: 'L1 transaction reverted'
        }
      }
    ],
    failureClassification: [
      {
        type: 'LOW_GAS_LIMIT',
        message: 'maxGas (100000) may be insufficient. Consider increasing to at least 150000.',
        severity: 'warning'
      },
      {
        type: 'L1_FAILURE',
        message: 'L1 transaction reverted',
        severity: 'critical'
      }
    ],
    summary: {
      totalSteps: 4,
      successCount: 2,
      failureCount: 1
    }
  },
  stylusMetadata: {
    isWasmContract: false,
    wasmAddress: null,
    gasUsedByWasm: null,
    panicDetected: false,
    panicReason: null,
    returnData: null,
    rawRevertData: null
  },
  rawData: {
    l1Receipt: {
      transactionHash: '0x1234567890abcdef...',
      status: 0,
      blockNumber: 19500000
    },
    l2Receipt: null,
    retryableTickets: [
      {
        eventName: 'RetryableTicketCreated',
        ticketId: '12345',
        from: '0x1234567890abcdef...',
        to: '0xabcdef1234567890...',
        l2CallValue: '10000000000000000',
        excessFeeRefundAddress: '0x1111111111111111...',
        callValueRefundAddress: '0x2222222222222222...',
        gasLimit: '100000',
        maxFeePerGas: '5000000000',
        data: '0x...',
        logIndex: 5,
        blockNumber: 19500000,
        transactionHash: '0x1234567890abcdef...'
      }
    ],
    l1Logs: [
      {
        logIndex: 0,
        address: '0x1100000000000000000000000000000000000011',
        topics: [
          '0x6895c13664aa4ec07a8cb63d2461fa21c84edf81640cf9a7ceae7e534d30e10a',
          '0x000000000000000000000000abcd1234567890abcd1234567890abcd12345678',
          '0x0000000000000000000000001111111111111111111111111111111111111111'
        ],
        data: '0x00000000000000000000000000000000000000000000000000000000000186a000000000000000000000000000000000000000000000000000b1a2bc2ec50000',
        transactionIndex: 0,
        removed: false
      },
      {
        logIndex: 1,
        address: '0x1100000000000000000000000000000000000011',
        topics: [
          '0x5e3c1311ea442664e8b1611bfabef659120ea7a0c3dd7def57f629971dc37a02'
        ],
        data: '0x000000000000000000000000cafe000000000000000000000000000000000001',
        transactionIndex: 1,
        removed: false
      }
    ],
    l2Logs: [],
    gasPriceHistory: {
      history: [
        {
          blockNumber: 19500000,
          baseFeePerGas: '45000000000',
          timestamp: 1700000000,
          gasUsed: '15000000',
          gasLimit: '30000000'
        },
        {
          blockNumber: 19500001,
          baseFeePerGas: '48000000000',
          timestamp: 1700000012,
          gasUsed: '14500000',
          gasLimit: '30000000'
        }
      ],
      range: { start: 19499999, latest: 19500001, count: 2 }
    },
    traceAnalysis: null,
    l2TraceInfo: null
  },
  errors: []
}

export const SAMPLE_RESPONSE_L2_REVERT = {
  txHash: '0xabcdef1234567890...',
  foundOn: 'L2',
  timeline: {
    actions: [
      {
        id: 1,
        timestamp: null,
        action: 'L2_EXECUTION',
        status: 'failed',
        isTerminal: true,
        color: '#ef4444',
        details: {
          txHash: '0xabcdef1234567890...',
          blockNumber: '200000000',
          gasUsed: '50000',
          to: '0xdeadbeef...',
          from: '0xcafebabe...'
        }
      },
      {
        id: 2,
        timestamp: null,
        action: 'FAILURE',
        status: 'failed',
        isTerminal: true,
        color: '#ef4444',
        details: {
          location: 'L2',
          reason: 'L2 execution reverted'
        }
      }
    ],
    failureClassification: [
      {
        type: 'L2_REVERT',
        message: 'L2 execution reverted. Check contract logic or calldata.',
        severity: 'critical'
      }
    ],
    summary: {
      totalSteps: 2,
      successCount: 0,
      failureCount: 1
    }
  },
  stylusMetadata: {
    isWasmContract: false,
    wasmAddress: null,
    panicDetected: false,
    panicReason: null
  },
  rawData: {
    l1Receipt: null,
    l2Receipt: {
      transactionHash: '0xabcdef1234567890...',
      status: 0,
      blockNumber: 200000000,
      gasUsed: '50000',
      gasLimit: '100000',
      from: '0xcafebabe...',
      to: '0xdeadbeef...',
      logsCount: 2,
      type: 2
    },
    l1Logs: [],
    l2Logs: [
      {
        logIndex: 0,
        address: '0x0000000000000000000000000000000000000001',
        topics: [
          '0x000000000000000000000000000000000000000000000000000000000000dead'
        ],
        data: '0x',
        removed: false,
        blockHash: '0xbeef...'
      },
      {
        logIndex: 1,
        address: '0x0000000000000000000000000000000000000002',
        topics: [
          '0xcafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe'
        ],
        data: '0x0000000000000000000000000000000000000000000000000000000000000001',
        removed: false,
        blockHash: '0xbeef...'
      }
    ],
    gasPriceHistory: {
      history: [
        {
          blockNumber: 200000000,
          baseFeePerGas: '2500000000',
          timestamp: 1700000100,
          gasUsed: '25000000',
          gasLimit: '30000000'
        }
      ],
      range: { start: 199999999, latest: 200000000, count: 1 }
    },
    traceAnalysis: {
      memoryAccesses: [
        { offset: 0, size: 32, type: 'MLOAD' },
        { offset: 32, size: 32, type: 'MSTORE' }
      ],
      storageAccesses: [
        { address: '0xdeadbeef...', slot: '0x0', type: 'SLOAD', value: '0x01' }
      ]
    },
    l2TraceInfo: {
      transactionHash: '0xabcdef1234567890...',
      blockNumber: 200000000,
      gasUsed: '50000',
      status: 0,
      to: '0xdeadbeef...',
      from: '0xcafebabe...',
      logs: 2,
      contractAddress: null,
      calldata: '0x'
    }
  },
  errors: []
}

export const SAMPLE_RESPONSE_STYLUS_PANIC = {
  txHash: '0x9876543210fedcba...',
  foundOn: 'L2',
  timeline: {
    actions: [
      {
        id: 1,
        timestamp: null,
        action: 'STYLUS_WASM_EXECUTION',
        status: 'failed',
        isTerminal: false,
        color: '#ef4444',
        details: {
          'WASM Precompile': '0x0000000000000000000000000000000000000071',
          'Gas Used': '500000',
          'Status': 'failure',
          'Logs Emitted': 3,
          'Panic Detected': 'Yes'
        }
      },
      {
        id: 2,
        timestamp: null,
        action: 'FAILURE',
        status: 'failed',
        isTerminal: true,
        color: '#ef4444',
        details: {
          location: 'L2',
          reason: 'WASM contract execution reverted'
        }
      }
    ],
    failureClassification: [
      {
        type: 'WASM_PANIC',
        message: 'WASM Panic: Arithmetic underflow or overflow',
        severity: 'critical',
        code: '0x11'
      },
      {
        type: 'WASM_REVERT',
        message: 'WASM contract execution reverted. Check calldata and contract logic.',
        severity: 'critical'
      }
    ],
    summary: {
      totalSteps: 2,
      successCount: 0,
      failureCount: 2
    }
  },
  stylusMetadata: {
    isWasmContract: true,
    wasmAddress: '0x0000000000000000000000000000000000000071',
    gasUsedByWasm: '500000',
    panicDetected: true,
    panicReason: 'Panic',
    returnData: '0x4e487b7100000000000000000000000000000000000000000000000000000011',
    rawRevertData: '0x4e487b7100000000000000000000000000000000000000000000000000000011'
  },
  rawData: {
    l1Receipt: null,
    l2Receipt: {
      transactionHash: '0x9876543210fedcba...',
      status: 0,
      blockNumber: 200000100,
      gasUsed: '500000',
      gasLimit: '800000',
      from: '0x1234567890abcdef...',
      to: '0x0000000000000000000000000000000000000071',
      logsCount: 3,
      type: 2
    },
    l1Logs: [],
    l2Logs: [
      {
        logIndex: 0,
        address: '0x0000000000000000000000000000000000000071',
        topics: [
          '0x1234567890abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef'
        ],
        data: '0x4e487b7100000000000000000000000000000000000000000000000000000011',
        removed: false,
        blockHash: '0xabcd...'
      },
      {
        logIndex: 1,
        address: '0x0000000000000000000000000000000000000071',
        topics: [
          '0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
        ],
        data: '0x',
        removed: false,
        blockHash: '0xabcd...'
      },
      {
        logIndex: 2,
        address: '0x0000000000000000000000000000000000000071',
        topics: [
          '0x9999999999999999999999999999999999999999999999999999999999999999'
        ],
        data: '0x0000000000000000000000000000000000000000000000000000000000000011',
        removed: false,
        blockHash: '0xabcd...'
      }
    ],
    gasPriceHistory: {
      history: [
        {
          blockNumber: 200000099,
          baseFeePerGas: '2300000000',
          timestamp: 1700000200,
          gasUsed: '28000000',
          gasLimit: '30000000'
        },
        {
          blockNumber: 200000100,
          baseFeePerGas: '2450000000',
          timestamp: 1700000212,
          gasUsed: '25500000',
          gasLimit: '30000000'
        }
      ],
      range: { start: 200000099, latest: 200000100, count: 2 }
    },
    traceAnalysis: {
      memoryAccesses: [
        { offset: 0, size: 32, type: 'MLOAD' },
        { offset: 32, size: 32, type: 'MSTORE' },
        { offset: 64, size: 64, type: 'MLOAD' }
      ],
      storageAccesses: [
        { address: '0x0000000000000000000000000000000000000071', slot: '0x0', type: 'SLOAD', value: '0x0' },
        { address: '0x0000000000000000000000000000000000000071', slot: '0x1', type: 'SSTORE', value: '0x1' }
      ]
    },
    l2TraceInfo: {
      transactionHash: '0x9876543210fedcba...',
      blockNumber: 200000100,
      gasUsed: '500000',
      status: 0,
      to: '0x0000000000000000000000000000000000000071',
      from: '0x1234567890abcdef...',
      logs: 3,
      contractAddress: null,
      calldata: '0xabcd1234'
    }
  },
  errors: []
}
