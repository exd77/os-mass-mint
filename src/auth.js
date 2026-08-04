/**
 * Auth Module — scrypt password hashing + session management
 * No external deps. Uses Node.js built-in crypto.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const AUTH_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.auth.json');

const SESSION_DURATION = 1000 * 60 * 60 * 24; // 24 hours

// ─── Password hashing (scrypt) ───

function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const { hash: computedHash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computedHash, 'hex'));
}

// ─── Auth file management ───

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  fs.chmodSync(AUTH_FILE, 0o600); // owner read/write only
}

function isAuthEnabled() {
  const auth = loadAuth();
  return auth && auth.enabled && auth.hash && auth.salt;
}

function setPassword(password) {
  const { hash, salt } = hashPassword(password);
  saveAuth({ enabled: true, hash, salt, createdAt: Date.now() });
}

function changePassword(oldPassword, newPassword) {
  const auth = loadAuth();
  if (!auth || !auth.enabled) throw new Error('auth not enabled');
  if (!verifyPassword(oldPassword, auth.hash, auth.salt)) throw new Error('wrong password');
  setPassword(newPassword);
}

function disableAuth() {
  const auth = loadAuth();
  if (auth) {
    auth.enabled = false;
    saveAuth(auth);
  }
}

// ─── Session management ───

const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_DURATION });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function destroySession(token) {
  sessions.delete(token);
}

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(token);
  }
}, 1000 * 60 * 10).unref();

export {
  hashPassword, verifyPassword,
  loadAuth, saveAuth, isAuthEnabled,
  setPassword, changePassword, disableAuth,
  createSession, isValidSession, destroySession,
};
