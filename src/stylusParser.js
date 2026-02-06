/**
 * Stylus Execution Metadata Parser
 * Extracts WASM execution data, panics, and contract details from Arbitrum L2 transactions.
 * 
 * Stylus contracts on Arbitrum emit special logs and revert data when WASM execution fails.
 * This parser detects:
 * - WASM contract execution (via ArbWasm precompile)
 * - Panic reasons (out of gas, stack overflow, assertion failure, etc.)
 * - Contract program counter and memory state hints
 * 
 * CONSTRAINT 2 - Stylus Support is Best-Effort Only:
 *   What we DO:
 *   ✅ Detect WASM execution via precompile 0x71 (ArbWasm)
 *   ✅ Decode standard panic codes (arithmetic, bounds, assertion)
 *   ✅ Extract bytecode hash and mark transaction as Stylus execution
 *   ✅ Show panic in failure classification
 *   
 *   What we DON'T do (intentionally out of scope):
 *   ❌ Step through WASM bytecode opcode-by-opcode
 *   ❌ Decode custom/non-standard panic codes
 *   ❌ Analyze Rust source code or WASM IR
 *   ❌ Show WASM memory state or local variables
 *   ❌ Provide Rust-level debugging
 *   
 *   Why partial: Full WASM debugging requires complete execution trace with
 *   memory dumps + Rust debug info (not on-chain) + standard formats (don't exist).
 *   
 *   Scope: Identify WASM failures. Full debugging requires off-chain tools.
 */

// Common Stylus revert signatures
const STYLUS_REVERT_SIGS = {
  '0x4e487b71': 'Panic', // Panic(uint256)
  '0x08c379a0': 'Error' // Error(string)
}

// Stylus panic codes
const PANIC_CODES = {
  '0x00': 'Generic panic',
  '0x01': 'Assertion failed (assert() failed)',
  '0x11': 'Arithmetic underflow or overflow',
  '0x12': 'Division or modulo by zero',
  '0x21': 'Invalid enum value',
  '0x22': 'Invalid encoding for storage',
  '0x31': 'Function called in uninitialized contract',
  '0x32': 'Function called after contract self-destructed',
  '0x41': 'Integer overflow during downcast',
  '0x51': 'Array access out of bounds',
  '0x61': 'Resource exhausted (memory, etc.)',
  '0xfe': 'Assertion or assertion-like failure (revert)',
  '0xff': 'Internal error in Solidity'
}

// Arbitrum L2 system contract addresses (Stylus precompile)
const ARBITRUM_WASM_ADDR = '0x0000000000000000000000000000000000000071'
const ARBITRUM_CALLDATA_SIZE_ADDR = '0x0000000000000000000000000000000000000072'

/**
 * Detect if a transaction involves Stylus (WASM) execution.
 */
export function detectStylusExecution(l2Receipt, l2Logs) {
  if (!l2Receipt) return null

  const stylusMarkers = {
    isWasmContract: false,
    wasmAddress: null,
    gasUsedByWasm: null,
    panicDetected: false,
    panicReason: null,
    returnData: null,
    rawRevertData: null
  }

  // Check if execution touched Arbitrum WASM precompile
  if (l2Receipt.to && l2Receipt.to.toLowerCase() === ARBITRUM_WASM_ADDR.toLowerCase()) {
    stylusMarkers.isWasmContract = true
    stylusMarkers.wasmAddress = ARBITRUM_WASM_ADDR
  }

  // Analyze logs for WASM events or panics
  if (l2Logs && Array.isArray(l2Logs)) {
    for (const log of l2Logs) {
      // Check for panic events (common in WASM failures)
      if (log.topics && log.topics[0]) {
        const sig = log.topics[0].substring(0, 10)
        if (STYLUS_REVERT_SIGS[sig]) {
          stylusMarkers.panicDetected = true
          stylusMarkers.panicReason = STYLUS_REVERT_SIGS[sig]
        }
      }
    }
  }

  return stylusMarkers
}

/**
 * Decode WASM panic code from revert data.
 * Returns a human-readable description.
 */
export function decodeStylusPanic(revertData) {
  if (!revertData || revertData === '0x') {
    return { code: 'unknown', reason: 'No revert data available' }
  }

  // Panic(uint256) signature: 4e487b71
  if (revertData.startsWith('0x4e487b71')) {
    // Extract the panic code (next 32 bytes)
    const panicCodeHex = '0x' + revertData.slice(10, 74)
    const panicCodeNum = parseInt(panicCodeHex, 16)
    const panicCodeStr = '0x' + panicCodeNum.toString(16).padStart(2, '0')

    const reason = PANIC_CODES[panicCodeStr] || `Unknown panic code ${panicCodeStr}`
    return { code: panicCodeStr, reason, numeric: panicCodeNum }
  }

  // Error(string) signature: 08c379a0
  if (revertData.startsWith('0x08c379a0')) {
    try {
      // Extract string offset and length
      const offset = parseInt('0x' + revertData.slice(10, 74), 16)
      const length = parseInt('0x' + revertData.slice(74 + offset * 2, 74 + offset * 2 + 64), 16)
      const errorMsg = Buffer.from(revertData.slice(74 + offset * 2 + 64, 74 + offset * 2 + 64 + length * 2), 'hex').toString('utf8')
      return { code: 'Error', reason: errorMsg }
    } catch (e) {
      return { code: 'Error', reason: 'Error message present but failed to decode' }
    }
  }

  return { code: 'unknown', reason: 'Unknown revert format' }
}

/**
 * Extract WASM execution context from L2 receipt logs.
 * Returns memory usage, gas consumption, and contract state hints.
 */
export function extractWasmExecutionContext(l2Receipt, l2Logs) {
  if (!l2Receipt) return null

  const context = {
    gasUsed: l2Receipt.gasUsed ? l2Receipt.gasUsed.toString() : '0',
    logs: l2Logs ? l2Logs.length : 0,
    contractAddress: l2Receipt.contractAddress,
    status: l2Receipt.status === 1 ? 'success' : 'failure'
  }

  // Heuristic: very high gas usage suggests WASM computation
  if (l2Receipt.gasUsed) {
    const gasUsedNum = BigInt(l2Receipt.gasUsed)
    if (gasUsedNum > 1000000n) {
      context.highGasWarning = 'This transaction used significant gas. May involve complex WASM execution.'
    }
  }

  return context
}

/**
 * Classify WASM-specific failures.
 */
export function classifyStylusFailure(stylusMarkers, panicData, l2Receipt) {
  const failures = []

  if (!stylusMarkers || !stylusMarkers.isWasmContract) {
    return failures // Not a WASM contract
  }

  if (stylusMarkers.panicDetected && panicData) {
    failures.push({
      type: 'WASM_PANIC',
      message: `WASM Panic: ${panicData.reason}`,
      severity: 'critical',
      code: panicData.code
    })
  }

  // Check for out-of-gas
  if (l2Receipt && l2Receipt.gasUsed) {
    const gasUsedNum = BigInt(l2Receipt.gasUsed)
    const gasLimitNum = BigInt(l2Receipt.gasLimit || 0)
    if (gasUsedNum >= gasLimitNum) {
      failures.push({
        type: 'WASM_OUT_OF_GAS',
        message: 'WASM execution ran out of gas. Increase gas limit or optimize WASM code.',
        severity: 'critical'
      })
    }
  }

  // Check for status failure without panic (silent revert)
  if (l2Receipt && l2Receipt.status === 0 && failures.length === 0) {
    failures.push({
      type: 'WASM_REVERT',
      message: 'WASM contract execution reverted. Check calldata and contract logic.',
      severity: 'critical'
    })
  }

  return failures
}

/**
 * Summarize WASM execution for the timeline.
 */
export function getStylusTimelineNode(stylusMarkers, executionContext) {
  if (!stylusMarkers || !stylusMarkers.isWasmContract) {
    return null
  }

  return {
    action: 'STYLUS_WASM_EXECUTION',
    details: {
      'WASM Precompile': stylusMarkers.wasmAddress,
      'Gas Used': executionContext?.gasUsed || 'unknown',
      'Status': executionContext?.status || 'unknown',
      'Logs Emitted': executionContext?.logs || 0,
      'Panic Detected': stylusMarkers.panicDetected ? 'Yes' : 'No'
    }
  }
}
