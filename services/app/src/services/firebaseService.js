'use strict';

/**
 * firebaseService.js
 * Wraps Firebase Admin SDK for token storage.
 * Initialised lazily so the app can boot in environments without a service
 * account (useful for early development) — but writes will fail loud.
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { sanitizeEmail } = require('../utils/sanitize');

const log = {
  info: (msg) => console.log(`ℹ  [FIREBASE] ${msg}`),
  warn: (msg) => console.warn(`⚠  [FIREBASE] ${msg}`),
  err:  (msg) => console.error(`✗  [FIREBASE] ${msg}`),
  ok:   (msg) => console.log(`✓  [FIREBASE] ${msg}`),
};

let initialized = false;
let initError = null;
let resolvedConfig = null;

const JSON_PROJECT_ID_KEYS = ['project_id', 'projectId'];
const JSON_DATABASE_URL_KEYS = [
  'databaseURL',
  'databaseUrl',
  'database_url',
  'firebase_database_url',
  'firebaseDatabaseURL',
  'firebaseDatabaseUrl',
];

function getEnv(name, fallback = '') {
  const exact = process.env[name];
  if (exact !== undefined && String(exact).trim() !== '') return exact;

  const wanted = name.toLowerCase();
  const foundKey = Object.keys(process.env).find((key) => (
    key.toLowerCase() === wanted
    && process.env[key] !== undefined
    && String(process.env[key]).trim() !== ''
  ));
  if (foundKey) return process.env[foundKey];
  return exact !== undefined ? exact : fallback;
}

function getEnvTrimmed(name, fallback = '') {
  return String(getEnv(name, fallback) || '').trim();
}

function normalizeKey(key) {
  return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function pickJsonString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';

  const wanted = new Set(keys.map(normalizeKey));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(normalizeKey(key)) && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function decodeServiceAccountBase64(encoded) {
  const raw = encoded.includes(',') ? encoded.slice(encoded.indexOf(',') + 1) : encoded;
  return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

function readServiceAccountFromFile(saPath) {
  const resolvedSaPath = path.isAbsolute(saPath) ? saPath : path.resolve(process.cwd(), saPath);
  if (!fs.existsSync(resolvedSaPath)) return { serviceAccount: null, resolvedSaPath };

  const stat = fs.statSync(resolvedSaPath);
  if (!stat.isFile()) return { serviceAccount: null, resolvedSaPath };

  return {
    serviceAccount: JSON.parse(fs.readFileSync(resolvedSaPath, 'utf8')),
    resolvedSaPath,
  };
}

function buildConfig() {
  const serviceAccountBase64 = getEnvTrimmed('FIREBASE_SERVICE_ACCOUNT_BASE64');
  const configuredSaPath = getEnvTrimmed('FIREBASE_SERVICE_ACCOUNT_PATH', './serviceAccount.json');
  const googleApplicationCredentials = getEnvTrimmed('GOOGLE_APPLICATION_CREDENTIALS');

  let serviceAccount = null;
  let serviceAccountSource = null;
  let serviceAccountPath = configuredSaPath || './serviceAccount.json';
  let resolvedSaPath = path.isAbsolute(serviceAccountPath)
    ? serviceAccountPath
    : path.resolve(process.cwd(), serviceAccountPath);

  if (serviceAccountBase64) {
    serviceAccount = decodeServiceAccountBase64(serviceAccountBase64);
    serviceAccountSource = 'base64';
  } else {
    const fromFile = readServiceAccountFromFile(serviceAccountPath);
    serviceAccount = fromFile.serviceAccount;
    resolvedSaPath = fromFile.resolvedSaPath;
    if (serviceAccount) serviceAccountSource = 'path';
  }

  const projectId = pickJsonString(serviceAccount, JSON_PROJECT_ID_KEYS)
    || getEnvTrimmed('FIREBASE_PROJECT_ID');
  const databaseURL = pickJsonString(serviceAccount, JSON_DATABASE_URL_KEYS)
    || getEnvTrimmed('FIREBASE_DATABASE_URL');

  return {
    databaseURL,
    projectId,
    serviceAccount,
    serviceAccountSource,
    serviceAccountPath,
    resolvedSaPath,
    googleApplicationCredentials,
    hasServiceAccountBase64: Boolean(serviceAccountBase64),
  };
}

function getConfigStatus() {
  let cfg = resolvedConfig;
  let configError = null;

  if (!cfg) {
    try {
      cfg = buildConfig();
    } catch (err) {
      configError = err.message;
    }
  }

  return {
    ready: initialized,
    databaseUrl: cfg?.databaseURL || null,
    projectId: cfg?.projectId || null,
    serviceAccountPath: cfg?.serviceAccountSource === 'path' ? cfg.serviceAccountPath : null,
    serviceAccountSource: cfg?.serviceAccountSource || (cfg?.googleApplicationCredentials ? 'applicationDefault' : null),
    hasServiceAccountBase64: Boolean(cfg?.hasServiceAccountBase64),
    configError,
  };
}

function init() {
  if (initialized) return;
  if (initError) throw initError;

  const cfg = buildConfig();
  resolvedConfig = cfg;

  if (!cfg.databaseURL) {
    initError = new Error('FIREBASE_DATABASE_URL is not set');
    throw initError;
  }

  let credential;
  if (cfg.serviceAccount) {
    if (cfg.projectId && !pickJsonString(cfg.serviceAccount, JSON_PROJECT_ID_KEYS)) {
      cfg.serviceAccount.project_id = cfg.projectId;
    }
    credential = admin.credential.cert(cfg.serviceAccount);
    if (cfg.serviceAccountSource === 'base64') {
      log.ok('Loaded service account from FIREBASE_SERVICE_ACCOUNT_BASE64');
    } else {
      log.ok(`Loaded service account from ${cfg.resolvedSaPath}`);
    }
  } else if (cfg.googleApplicationCredentials) {
    credential = admin.credential.applicationDefault();
    log.info('Using GOOGLE_APPLICATION_CREDENTIALS');
  } else {
    initError = new Error(`Service account not found at ${cfg.resolvedSaPath}`);
    throw initError;
  }

  admin.initializeApp({ credential, databaseURL: cfg.databaseURL, projectId: cfg.projectId || undefined });
  initialized = true;
  log.ok(`Firebase initialised (db=${cfg.databaseURL})`);
}

function isReady() {
  try { init(); return true; } catch (_) { return false; }
}

/**
 * Persist a token. The raw file content is stored verbatim, plus a parsed
 * version when the content is valid JSON. createdAt is set only on first save.
 */
async function saveToken(email, rawContent, sessionId, extra = {}) {
  init();
  const key = sanitizeEmail(email);
  if (!key) throw new Error('Invalid email');
  const base64 = Buffer.from(rawContent, 'utf8').toString('base64');

  let parsed = null;
  try {
    parsed = JSON.parse(rawContent);
  } catch (_) {
    parsed = { raw: rawContent };
  }

  const ref = admin.database().ref(`tokens/${key}`);
  const snap = await ref.once('value');
  const now = Date.now();

  const data = {
    email,
    raw: rawContent,
    parsed,
    base64,
    updatedAt: now,
    lastSessionId: sessionId,
    ...extra,
  };
  if (!snap.exists()) data.createdAt = now;

  await ref.update(data);
  log.ok(`Saved token for ${email} → /tokens/${key}`);
  return key;
}

/**
 * List token metadata only — never expose raw/parsed payloads via this method.
 */
async function listTokens() {
  init();
  const snap = await admin.database().ref('tokens').once('value');
  const all = snap.val() || {};
  return Object.entries(all).map(([key, val]) => ({
    key,
    email: val.email,
    createdAt: val.createdAt || null,
    updatedAt: val.updatedAt || null,
  })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function getTokenDetail(key) {
  init();
  if (!key || typeof key !== 'string') throw new Error('Invalid token key');

  const snap = await admin.database().ref(`tokens/${key}`).once('value');
  if (!snap.exists()) return null;

  const val = snap.val() || {};
  const raw = typeof val.raw === 'string'
    ? val.raw
    : (typeof val.base64 === 'string' ? Buffer.from(val.base64, 'base64').toString('utf8') : '');
  const base64 = typeof val.base64 === 'string'
    ? val.base64
    : Buffer.from(raw, 'utf8').toString('base64');
  let parsed = val.parsed || null;
  if (!parsed && raw) {
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = { raw };
    }
  }

  return {
    key,
    email: val.email || null,
    createdAt: val.createdAt || null,
    updatedAt: val.updatedAt || null,
    lastSessionId: val.lastSessionId || null,
    raw,
    parsed,
    base64,
    base64Decoded: Buffer.from(base64, 'base64').toString('utf8'),
  };
}



async function exportTokensBackup() {
  init();
  const snap = await admin.database().ref('tokens').once('value');
  return snap.val() || {};
}

async function restoreTokensBackup(tokensMap) {
  init();
  if (!tokensMap || typeof tokensMap !== 'object' || Array.isArray(tokensMap)) {
    throw new Error('Invalid backup payload');
  }
  const now = Date.now();
  const normalized = {};
  for (const [key, val] of Object.entries(tokensMap)) {
    if (!val || typeof val !== 'object') continue;
    normalized[key] = {
      email: val.email || null,
      raw: typeof val.raw === 'string' ? val.raw : '',
      parsed: val.parsed || null,
      base64: typeof val.base64 === 'string' ? val.base64 : Buffer.from(String(val.raw || ''), 'utf8').toString('base64'),
      createdAt: Number(val.createdAt) || now,
      updatedAt: Number(val.updatedAt) || now,
      lastSessionId: val.lastSessionId || null,
    };
  }
  await admin.database().ref('tokens').set(normalized);
  return Object.keys(normalized).length;
}

module.exports = { init, isReady, saveToken, listTokens, getTokenDetail, exportTokensBackup, restoreTokensBackup, getConfigStatus, getEnv };
