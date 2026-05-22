// ──────────────────────────────────────────────────────────────
// adapters/kyc/pan.adapter.js — Mock PAN API Adapter with Circuit Breaker
// ──────────────────────────────────────────────────────────────

import { CircuitBreaker } from '../../utils/circuit-breaker.js';

const panBreaker = new CircuitBreaker('PAN_NSDL_API', 3, 30000);

/**
 * Validates a PAN number by simulating a vendor API call.
 * Format: 5 Letters, 4 Numbers, 1 Letter (e.g., ABCDE1234F).
 */
export async function verifyPan(panNumber) {
  return panBreaker.fire(async () => {
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Simulate a vendor outage if panNumber is explicitly meant to break
    if (panNumber === 'OUTAGE1234') {
      const err = new Error('Vendor API Gateway Timeout');
      err.isVendorOutage = true; // Signals CB to count this failure
      throw err;
    }

    // Vendor API validation logic
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    
    if (!panNumber || !panRegex.test(panNumber)) {
      const error = new Error('Invalid PAN Format');
      error.statusCode = 400;
      error.details = { vendorStatus: 'INVALID_FORMAT', panNumber };
      // 400 errors do not have isVendorOutage = true, so they don't trip the breaker
      throw error; 
    }

    // Return success response structure
    return {
      valid: true,
      panNumber,
      holderName: "MOCK HOLDER NAME",
      vendorStatus: "VALID"
    };
  });
}
