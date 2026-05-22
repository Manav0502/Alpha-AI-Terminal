// ──────────────────────────────────────────────────────────────
// controllers/webhook.controller.js — Async KYC Vendor Webhooks
// ──────────────────────────────────────────────────────────────

import { getPool } from '../db.js';
import { updateKycStatus, findUserProfileByUserId } from '../repository/user_profile.repository.js';
import { transitionState } from '../utils/kyc.state.js';

export async function handleKycVendorWebhook(req, reply) {
  const { userId, status } = req.body || {};

  if (!userId || !status) {
    return reply.status(400).send({ error: 'Missing userId or status in payload' });
  }

  const pool = getPool();

  try {
    const newState = await pool.$transaction(async (tx) => {
      const profile = await findUserProfileByUserId(tx, userId);
      if (!profile) {
        throw new Error(`Profile not found for userId: ${userId}`);
      }

      // Enforce state transition guard
      const nextState = transitionState(profile.kyc_status, status);

      // Persist new state
      await updateKycStatus(tx, userId, nextState);
      return nextState;
    });

    return reply.status(200).send({ message: 'Webhook processed successfully', newState });
  } catch (err) {
    req.log.error(err);

    if (err.message.includes('Invalid state transition')) {
      return reply.status(400).send({ error: err.message });
    }
    return reply.status(500).send({ error: 'Internal Server Error processing webhook' });
  }
}
