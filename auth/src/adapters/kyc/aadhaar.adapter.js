// ──────────────────────────────────────────────────────────────
// adapters/kyc/aadhaar.adapter.js — Mock Aadhaar e-KYC Adapter
// ──────────────────────────────────────────────────────────────

import { CircuitBreaker } from '../../utils/circuit-breaker.js';

const aadhaarBreaker = new CircuitBreaker('AADHAAR_UIDAI_API', 3, 30000);

/**
 * Initiates an Aadhaar e-KYC flow (mock).
 */
export async function verifyAadhaar(aadhaarNumber) {
  return aadhaarBreaker.fire(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    
    if (aadhaarNumber === '000000000000') {
      const err = new Error('UIDAI Servers Unreachable');
      err.isVendorOutage = true;
      throw err;
    }

    const aadhaarRegex = /^[2-9]{1}[0-9]{11}$/;
    if (!aadhaarNumber || !aadhaarRegex.test(aadhaarNumber)) {
      const error = new Error('Invalid Aadhaar Format');
      error.statusCode = 400;
      error.details = { vendorStatus: 'INVALID_FORMAT', aadhaarNumber };
      throw error;
    }

    return {
      valid: true,
      aadhaarNumber,
      uidaiStatus: "VERIFIED"
    };
  });
}
