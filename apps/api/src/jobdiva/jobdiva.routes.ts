// Phase 5.5 — JobDiva contact lookup endpoint.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { lookupContactByPhone, type JobDivaContact } from './client.js';
import { config } from '../config.js';

interface JwtPayload {
  sub: number;
  email: string;
  isAdmin: boolean;
}

// Simple in-memory cache so we don't hammer JobDiva for repeat lookups
// (e.g. when Recents renders 50 rows for the same contact).
interface CacheEntry {
  value: JobDivaContact | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheGet(key: string): JobDivaContact | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: JobDivaContact | null): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function normalizeKey(phone: string): string {
  return (phone ?? '').replace(/[^\d]/g, '').slice(-10);
}

export async function jobDivaRoutes(app: FastifyInstance) {
  // GET /jobdiva/contact?phone=+15551234567
  // Returns: { found: true, contact: {...} } or { found: false }
  app.get(
    '/jobdiva/contact',
    { onRequest: [app.authenticate] },
    async (request: FastifyRequest) => {
      const { phone } = request.query as { phone?: string };
      if (!phone) return { found: false };
      if (!config.jobDivaBaseUrl) {
        return { found: false, reason: 'jobdiva_not_configured' };
      }

      const key = normalizeKey(phone);
      if (!key || key.length < 7) return { found: false };

      const cached = cacheGet(key);
      if (cached !== undefined) {
        return cached ? { found: true, contact: cached, cached: true } : { found: false, cached: true };
      }

      const contact = await lookupContactByPhone(phone);
      cacheSet(key, contact);
      return contact ? { found: true, contact } : { found: false };
    }
  );
}
