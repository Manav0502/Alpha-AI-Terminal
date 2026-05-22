// ──────────────────────────────────────────────────────────────
// controllers/auth.controller.js — HTTP request handlers
// Thin layer: validates input shape, delegates to services,
// maps errors to HTTP status codes. No business logic here.
// ──────────────────────────────────────────────────────────────

import { registerUser, loginUser } from '../services/auth.service.js';
import { issueTokenPair, rotateRefreshToken, revokeSession } from '../services/token.service.js';
import { loginWithGoogle } from '../services/oauth.service.js';
import { generateMfa, verifyMfa, getMfaStatus } from '../services/mfa.service.js';
import { getPool } from '../db.js';
import { PasswordComplexityError, DuplicateEmailError, AuthenticationError } from '../errors/index.js';
import { config } from '../config.js';
import { signAccessToken } from '../crypto/jwt.provider.js';
import { findUserById } from '../repository/user.repository.js';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  maxAge: config.jwt.refreshTtl,
};

const ACCESS_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
  maxAge: config.jwt.accessTtl,
};

/**
 * POST /api/auth/register
 */
export async function handleRegister(request, reply) {
  const { email, password, displayName } = request.body || {};

  if (!email || !password) {
    return reply.status(400).send({ error: 'email and password are required.' });
  }

  try {
    const user = await registerUser(getPool(), { email, password, displayName });
    const { token: accessToken } = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      mfa_verified: false,
    });

    reply.clearCookie('refresh_token', { path: '/' });
    reply.clearCookie('access_token', { path: '/' });

    return reply.status(201).send({
      ok: true,
      accessToken,
      user,
      mfa_required: true,
      mfa_setup_required: true,
    });
  } catch (err) {
    if (err instanceof PasswordComplexityError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    if (err instanceof DuplicateEmailError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}

/**
 * GET /api/auth/health
 */
export async function handleHealth() {
  return { status: 'ok', service: 'ai-trade-auth' };
}

/**
 * POST /api/auth/login
 */
export async function handleLogin(request, reply) {
  const { email, password } = request.body || {};

  try {
    const user = await loginUser(getPool(), { email, password });
    const mfaStatus = await getMfaStatus(getPool(), user.id);
    const { token: accessToken } = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      mfa_verified: false,
    });

    reply.clearCookie('refresh_token', { path: '/' });
    reply.clearCookie('access_token', { path: '/' });

    return reply.status(200).send({
      ok: true,
      accessToken,
      user,
      mfa_required: true,
      mfa_setup_required: !mfaStatus.isActive,
    });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}

/**
 * POST /api/auth/refresh
 */
export async function handleRefresh(request, reply) {
  const oldRefreshToken = request.cookies?.refresh_token;

  try {
    const { accessToken, refreshToken } = await rotateRefreshToken(getPool(), oldRefreshToken);

    reply.setCookie('refresh_token', refreshToken, COOKIE_OPTS);
    reply.setCookie('access_token', accessToken, ACCESS_COOKIE_OPTS);
    return reply.status(200).send({ ok: true, accessToken });
  } catch (err) {
    if (err.statusCode) {
      // Clear cookie on auth/reuse error
      reply.clearCookie('refresh_token', { path: '/' });
      reply.clearCookie('access_token', { path: '/' });
      return reply.status(err.statusCode).send({ error: err.message });
    }
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}

/**
 * POST /api/auth/logout
 */
export async function handleLogout(request, reply) {
  const refreshToken = request.cookies?.refresh_token;
  const accessTokenJti = request.user?.jti;

  try {
    await revokeSession(getPool(), refreshToken, accessTokenJti);
    reply.clearCookie('refresh_token', { path: '/' });
    reply.clearCookie('access_token', { path: '/' });
    return reply.status(200).send({ ok: true });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}

/**
 * POST /api/auth/oauth/google
 */
export async function handleGoogleLogin(request, reply) {
  const { idToken } = request.body || {};

  try {
    const user = await loginWithGoogle(getPool(), idToken);
    const mfaStatus = await getMfaStatus(getPool(), user.id);
    const { token: accessToken } = signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      mfa_verified: false,
    });

    reply.clearCookie('refresh_token', { path: '/' });
    reply.clearCookie('access_token', { path: '/' });

    return reply.status(200).send({
      ok: true,
      accessToken,
      user,
      mfa_required: true,
      mfa_setup_required: !mfaStatus.isActive,
    });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}

/**
 * POST /api/auth/mfa/generate
 */
export async function handleGenerateMfa(request, reply) {
  try {
    const data = await generateMfa(getPool(), request.user);
    return reply.status(200).send({ ok: true, ...data });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}

/**
 * POST /api/auth/mfa/verify
 */
export async function handleVerifyMfa(request, reply) {
  const { token } = request.body || {};

  try {
    await verifyMfa(getPool(), request.user.id, token);

    // Issue a new token pair with mfa_verified: true
    // Because user parameter requires {id, email, role}, we have them in request.user
    const { accessToken, refreshToken } = await issueTokenPair(getPool(), {
      id: request.user.id,
      email: request.user.email,
      role: request.user.role
    }, true);

    reply.setCookie('refresh_token', refreshToken, COOKIE_OPTS);
    reply.setCookie('access_token', accessToken, ACCESS_COOKIE_OPTS);
    return reply.status(200).send({ ok: true, accessToken });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}

/**
 * GET /api/auth/session
 */
export async function handleSession(request, reply) {
  try {
    const user = await findUserById(getPool(), request.user.id);
    if (!user) {
      return reply.status(404).send({ error: 'User not found.' });
    }
    return reply.status(200).send({ ok: true, user });
  } catch (err) {
    request.log.error(err);
    return reply.status(500).send({ error: 'Internal server error.' });
  }
}
