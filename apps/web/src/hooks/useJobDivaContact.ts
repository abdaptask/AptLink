// Phase 5.5 — useJobDivaContact(phone)
// Returns the JobDiva contact for a phone number, or null.
// In-flight + in-memory cache so 50 Recents rows don't fire 50 lookups.
import { useEffect, useState } from 'react';
import { lookupJobDivaContact, type JobDivaContact } from '../api';

interface CacheEntry {
  value: JobDivaContact | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<JobDivaContact | null>>();
const TTL_MS = 5 * 60 * 1000;

function normalizeKey(phone: string): string {
  return (phone ?? '').replace(/[^\d]/g, '').slice(-10);
}

export function useJobDivaContact(phone: string | undefined | null): JobDivaContact | null {
  const [contact, setContact] = useState<JobDivaContact | null>(null);

  useEffect(() => {
    if (!phone) {
      setContact(null);
      return;
    }
    const key = normalizeKey(phone);
    if (!key || key.length < 7) {
      setContact(null);
      return;
    }

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      setContact(cached.value);
      return;
    }

    const token = sessionStorage.getItem('ace_token');
    if (!token) {
      setContact(null);
      return;
    }

    let cancelled = false;
    let promise = inflight.get(key);
    if (!promise) {
      promise = lookupJobDivaContact(token, phone)
        .catch(() => null)
        .then((v) => {
          cache.set(key, { value: v, expiresAt: Date.now() + TTL_MS });
          inflight.delete(key);
          return v;
        });
      inflight.set(key, promise);
    }

    promise.then((v) => {
      if (!cancelled) setContact(v);
    });

    return () => {
      cancelled = true;
    };
  }, [phone]);

  return contact;
}

// Synchronous helper for components that just want a label fast.
// Falls back to the provided formatted number if there's no cached match.
export function getCachedJobDivaName(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const key = normalizeKey(phone);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now() && cached.value) return cached.value.name;
  return null;
}
