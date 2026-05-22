// ──────────────────────────────────────────────────────────────
// controllers/kyc.controller.js — Handlers for KYC routes
// ──────────────────────────────────────────────────────────────

import { verifyPan } from '../adapters/kyc/pan.adapter.js';
import { generatePresignedUploadUrl } from '../services/s3.service.js';
import { getPool } from '../db.js';
import { upsertUserProfile, findUserProfileByUserId } from '../repository/user_profile.repository.js';
import { KYC_STATES } from '../utils/kyc.state.js';

export async function handleVerifyPan(req, reply) {
  const { panNumber } = req.body || {};
  try {
    const result = await verifyPan(panNumber);
    return reply.status(200).send(result);
  } catch (err) {
    if (err.isCircuitOpen) {
      return reply.status(503).send({ error: 'Service Unavailable', details: 'KYC Vendor is down' });
    }
    if (err.statusCode) {
      return reply.status(err.statusCode).send({ error: err.message, details: err.details });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Internal Server Error' });
  }
}

export async function handleLivenessCheck(req, reply) {
  const { blobBase64 } = req.body || {};

  if (!blobBase64) {
    return reply.status(400).send({ error: 'Missing selfie blob payload' });
  }

  // Simulate liveness detection
  const livenessScore = Math.random() * 100;

  if (livenessScore < 85) {
    return reply.status(403).send({ error: 'Liveness Check Failed', details: { score: livenessScore.toFixed(2) } });
  }

  return reply.status(200).send({
    status: 'VERIFIED',
    score: livenessScore.toFixed(2),
    message: 'Biometric liveness confirmed'
  });
}

export async function handleGetUploadUrl(req, reply) {
  const { documentType } = req.query || {};
  const userId = req.user.id;

  if (!['pan', 'aadhaar', 'selfie'].includes(documentType)) {
    return reply.status(400).send({ error: 'Invalid documentType. Must be pan, aadhaar, or selfie.' });
  }

  try {
    const { url, objectKey } = await generatePresignedUploadUrl(userId, documentType);
    return reply.status(200).send({ url, objectKey, expiresInSeconds: 600 });
  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: 'Failed to generate upload URL' });
  }
}

export async function handleUpsertProfile(req, reply) {
  const { legalName, panNumber, residentialAddress, aadhaarMetadata } = req.body || {};
  const userId = req.user.id;

  const pool = getPool();

  try {
    const existingProfile = await findUserProfileByUserId(pool, userId);
    const nextStatus =
      !existingProfile || existingProfile.kyc_status === KYC_STATES.PENDING
        ? KYC_STATES.BASIC_INFO_DONE
        : null;

    const profile = await upsertUserProfile(pool, {
      userId,
      legalName,
      panNumber,
      residentialAddress,
      aadhaarMetadata,
      kycStatus: nextStatus
    });
    return reply.status(200).send({ message: 'Profile updated successfully', profile });
  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: 'Failed to update profile' });
  }
}

export async function handleGetProfile(req, reply) {
  const userId = req.user.id;
  const pool = getPool();

  try {
    const profile = await findUserProfileByUserId(pool, userId);
    if (!profile) {
      return reply.status(404).send({ error: 'Profile not found' });
    }
    return reply.status(200).send({ profile });
  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: 'Failed to fetch profile' });
  }
}
