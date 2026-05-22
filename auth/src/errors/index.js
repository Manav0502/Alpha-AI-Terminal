// ──────────────────────────────────────────────────────────────
// errors/index.js — Centralized custom error classes
// All domain errors live here for clean imports across layers.
// ──────────────────────────────────────────────────────────────

export class PasswordComplexityError extends Error {
  constructor(reason) {
    super(`Password does not meet complexity requirements: ${reason}`);
    this.name = 'PasswordComplexityError';
    this.statusCode = 400;
  }
}

export class DuplicateEmailError extends Error {
  constructor(email) {
    super(`An account with email "${email}" already exists.`);
    this.name = 'DuplicateEmailError';
    this.statusCode = 409;
  }
}

export class AuthenticationError extends Error {
  constructor(message = 'Invalid credentials.') {
    super(message);
    this.name = 'AuthenticationError';
    this.statusCode = 401;
  }
}

export class NotFoundError extends Error {
  constructor(resource = 'Resource') {
    super(`${resource} not found.`);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class TokenReuseError extends Error {
  constructor(message = 'Token reuse detected. All sessions terminated.') {
    super(message);
    this.name = 'TokenReuseError';
    this.statusCode = 403;
  }
}
