// ──────────────────────────────────────────────────────────────
// middleware/kyc.guard.js — The Global KYC Lock
// ──────────────────────────────────────────────────────────────

import { getPool } from '../db.js';
import { findUserProfileByUserId } from '../repository/user_profile.repository.js';
import { KYC_STATES } from '../utils/kyc.state.js';

/**
 * Global middleware ensuring trading/orders are locked until KYC is VERIFIED.
 * Must be executed AFTER authGuard.
 */
export async function requireVerified(req, reply) {
  if (!req.user || !req.user.id) {
    return reply.status(401).send({ error: 'Unauthorized. User context missing.' });
  }

  const pool = getPool();

  try {
    const profile = await findUserProfileByUserId(pool, req.user.id);

    const currentStatus = profile ? profile.kyc_status : KYC_STATES.PENDING;

    if (currentStatus !== KYC_STATES.VERIFIED) {
      return reply.status(403).send({
        error: 'Precondition Failed',
        details: 'KYC must be VERIFIED to perform this action',
        currentStatus
      });
    }

  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: 'Failed to verify KYC status' });
  }
}
