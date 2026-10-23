/**
 * windowKeyManager.js — Stage 003 135-day window key schedule (plan §5).
 *
 * A key created on day S can only hash votes created on/after S. Keys rotate
 * every 30 days and live 135 days (90-day window + 30-day cadence + 15-day
 * jitter slack). Each vote is hashed under EVERY key valid at trip completion
 * (up to 5). Distinct-rider counts over any 90-day window are evaluated under
 * the oldest key created >= 90 days before the window end
 * (`getDeduplicationKey`), preventing the 1.6x–2.3x multi-key overcount.
 *
 * Cold start (t < 90d): the launch key serves with full unscaled publication
 * thresholds (15 riders / 5 drivers) — privacy floors are never relaxed.
 *
 * Zero dependencies. Provider-agnostic: KMS/Vault calls go through the
 * injected IKeyManagementProvider; Node crypto is the default fallback.
 */

import { createHmac } from 'node:crypto';

const DAY_MS = 86400000;
const KEY_LIFETIME_DAYS = 135;
const ROTATION_CADENCE_DAYS = 30;
const EVAL_WINDOW_DAYS = 90;
const COLD_START_DAYS = 90;

/**
 * @typedef {object} ActiveWindowKey
 * @property {string} keyId   e.g. "wk-2026-10"
 * @property {string} keyUri  Provider ARN or Vault key path
 * @property {Date} createdAt
 * @property {Date} expiresAt createdAt + 135 days
 */

class WindowKeyManager {
  /**
   * @param {object} provider IKeyManagementProvider {generateHmac,dispatch? no—generateHmac,disableKey,scheduleKeyDeletion}
   * @param {Date} launchDate
   * @param {string} staticIngestionSalt key-independent trip_hash salt
   */
  constructor(provider, launchDate, staticIngestionSalt) {
    if (!provider || typeof provider.generateHmac !== 'function') {
      throw new Error('WindowKeyManager: provider.generateHmac is required');
    }
    this.provider = provider;
    this.launchDate = launchDate;
    this.staticIngestionSalt = staticIngestionSalt;
    /** @type {ActiveWindowKey[]} */
    this.validKeys = [];
  }

  /** Register a rotation key (oldest first). Expired keys are never added. */
  addKey(key) {
    if (!(key.createdAt instanceof Date) || !(key.expiresAt instanceof Date)) {
      throw new Error('WindowKeyManager.addKey: createdAt/expiresAt must be Dates');
    }
    const expected = key.createdAt.getTime() + KEY_LIFETIME_DAYS * DAY_MS;
    if (Math.abs(expected - key.expiresAt.getTime()) > DAY_MS) {
      throw new Error(
        `WindowKeyManager.addKey: key ${key.keyId} lifetime != 135 days`,
      );
    }
    this.validKeys.push(key);
    this.validKeys.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Drop keys expired as of `asOf` (destruction follows provider waiting period). */
  pruneExpiredKeys(asOf = new Date()) {
    this.validKeys = this.validKeys.filter((k) => k.expiresAt >= asOf);
  }

  /**
   * Hash rider + driver under ALL currently valid keys (up to 5), plus the
   * key-independent trip_hash for retry idempotency across rotations.
   */
  async hashTripEvidenceForIngestion(riderUserId, driverId, tripId) {
    if (this.validKeys.length === 0) {
      throw new Error('Key rotation error: Zero active window keys available for ingestion');
    }
    if (!riderUserId || !driverId || !tripId) {
      throw new Error('hashTripEvidenceForIngestion: riderUserId, driverId, tripId required');
    }
    const pseudonyms = await Promise.all(
      this.validKeys.map(async (key) => {
        const [riderHash, driverHash] = await Promise.all([
          this.provider.generateHmac(key.keyUri, Buffer.from(riderUserId)),
          this.provider.generateHmac(key.keyUri, Buffer.from(driverId)),
        ]);
        return { keyId: key.keyId, riderHash, driverHash };
      }),
    );
    const tripHash = createHmac('sha256', this.staticIngestionSalt)
      .update(`trip-idempotency:${tripId}`)
      .digest('hex');
    return { pseudonyms, tripHash };
  }

  /**
   * Returns the qualifying key for distinct-rider aggregation over the
   * 90-day window ending at asOfDate. Cold start (t < 90d) returns the
   * launch key with isColdStart=true and partial windowDays.
   */
  getDeduplicationKey(asOfDate = new Date()) {
    const elapsedDays = (asOfDate.getTime() - this.launchDate.getTime()) / DAY_MS;

    if (elapsedDays < COLD_START_DAYS) {
      const launchKey = this.validKeys[0];
      if (!launchKey) throw new Error('Launch key missing during cold start');
      return {
        key: launchKey,
        isColdStart: true,
        windowDays: Math.max(1, Math.floor(elapsedDays)),
      };
    }

    const windowStart = new Date(asOfDate.getTime() - EVAL_WINDOW_DAYS * DAY_MS);
    const qualifying = this.validKeys.filter(
      (k) => k.createdAt <= windowStart && k.expiresAt >= asOfDate,
    );
    if (qualifying.length === 0) {
      throw new Error(
        `Key schedule error: No active key spans the full 90-day window [${windowStart.toISOString()} - ${asOfDate.toISOString()}]`,
      );
    }
    qualifying.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { key: qualifying[0], isColdStart: false, windowDays: 90 };
  }

  /** Convenience: oldest-qualifying key id for the aggregation view join. */
  getDedupKeyId(asOfDate = new Date()) {
    return this.getDeduplicationKey(asOfDate).key.keyId;
  }

  /** Right-to-erasure helper: hashes identifying one user under active keys. */
  async hashesForErasure(userId) {
    return Promise.all(
      this.validKeys.map(async (key) => ({
        keyId: key.keyId,
        pseudonymHash: await this.provider.generateHmac(key.keyUri, Buffer.from(userId)),
      })),
    );
  }
}

export {
  WindowKeyManager,
  KEY_LIFETIME_DAYS,
  ROTATION_CADENCE_DAYS,
  EVAL_WINDOW_DAYS,
  COLD_START_DAYS,
};
