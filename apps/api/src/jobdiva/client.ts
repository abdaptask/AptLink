// JobDiva API client — Phase 5.5.
//
// JobDiva exposes a REST API at api.jobdiva.com (tenants may differ).
// Auth model: GET /api/jobdiva/authenticate?clientid=...&username=...&password=...
// returns a bearer token. We cache it for the duration JobDiva says it's valid
// (or 12h as a conservative default), and refresh on 401.
//
// For the pilot we need just one operation: phone -> contact lookup. JobDiva's
// most useful endpoint here is `/api/jobdiva/searchcandidate` with a phone
// filter, or `/api/jobdiva/contacts/search`. We try both shapes so this works
// across tenants with minor schema differences.
import { config } from '../config.js';

interface CachedToken {
  token: string;
  expiresAt: number; // ms epoch
}

let tokenCache: CachedToken | null = null;

async function authenticate(): Promise<string | null> {
  if (!config.jobDivaBaseUrl || !config.jobDivaUsername || !config.jobDivaPassword) {
    return null;
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const params = new URLSearchParams({
    clientid: config.jobDivaClientId ?? '',
    username: config.jobDivaUsername,
    password: config.jobDivaPassword,
  });

  // Two common JobDiva auth shapes — try both:
  // 1. GET /api/jobdiva/authenticate?clientid=&username=&password=  → returns text token
  // 2. POST /api/jobdiva/authenticate  with same as JSON body       → returns JSON { token }
  const base = config.jobDivaBaseUrl.replace(/\/+$/, '');

  // Try GET first (typical for hosted JobDiva V2).
  try {
    const res = await fetch(`${base}/api/jobdiva/authenticate?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain' },
    });
    if (res.ok) {
      const text = await res.text();
      let token: string | null = null;
      try {
        const json = JSON.parse(text);
        token = json.token ?? json.access_token ?? json.bearer ?? null;
      } catch {
        // Plain text token
        token = text.replace(/^"|"$/g, '').trim() || null;
      }
      if (token) {
        tokenCache = { token, expiresAt: now + 12 * 60 * 60 * 1000 };
        return token;
      }
    }
  } catch {
    // fall through to POST attempt
  }

  // Fallback: POST JSON body.
  try {
    const res = await fetch(`${base}/api/jobdiva/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        clientid: config.jobDivaClientId,
        username: config.jobDivaUsername,
        password: config.jobDivaPassword,
      }),
    });
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const token =
        (json.token as string | undefined) ??
        (json.access_token as string | undefined) ??
        (json.bearer as string | undefined) ??
        null;
      if (token) {
        tokenCache = { token, expiresAt: now + 12 * 60 * 60 * 1000 };
        return token;
      }
    }
  } catch {
    // give up
  }

  return null;
}

export interface JobDivaContact {
  name: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  jobTitle?: string;
  email?: string;
  type?: 'candidate' | 'contact';
  sourceUrl?: string;
}

// Strip everything to digits + optional + sign so we can match on the right
// trailing 10 digits (JobDiva often stores numbers in inconsistent formats).
function normalizePhone(raw: string): string {
  const d = (raw ?? '').replace(/[^\d]/g, '');
  // Use the last 10 digits as the canonical US phone for matching.
  return d.length >= 10 ? d.slice(-10) : d;
}

export async function lookupContactByPhone(rawPhone: string): Promise<JobDivaContact | null> {
  const token = await authenticate();
  if (!token) return null;

  const phone = normalizePhone(rawPhone);
  if (phone.length < 7) return null;

  const base = config.jobDivaBaseUrl.replace(/\/+$/, '');
  const auth = `Bearer ${token}`;

  // Endpoint candidates — different JobDiva tenants expose different paths.
  // We try them in order and stop on the first non-empty match.
  const candidates = [
    `/api/jobdiva/searchcandidates?phone=${phone}`,
    `/api/jobdiva/searchcandidates?keyword=${phone}`,
    `/api/jobdiva/searchcontacts?phone=${phone}`,
    `/api/jobdiva/contacts/search?phone=${phone}`,
    `/api/jobdiva/getcandidates?phone=${phone}`,
  ];

  for (const path of candidates) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'GET',
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      if (res.status === 401) {
        // Token expired mid-flight; clear cache and bail. Caller can retry.
        tokenCache = null;
        return null;
      }
      if (!res.ok) continue;
      const json = (await res.json().catch(() => null)) as unknown;
      const match = pickFirstMatch(json, phone);
      if (match) return match;
    } catch {
      // try next
    }
  }

  return null;
}

// JobDiva's response shapes vary — sometimes { candidates: [...] }, sometimes
// a flat array, sometimes a single object. Walk the response and pick the first
// row whose phone digits match what we asked for.
function pickFirstMatch(payload: unknown, phone: string): JobDivaContact | null {
  const rows = flattenRows(payload);
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const candidatePhones = [
      r.phone,
      r.phoneNumber,
      r.phone_home,
      r.phone_work,
      r.phone_cell,
      r.mobilePhone,
      r.cellPhone,
      r.workPhone,
      r.homePhone,
    ]
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
      .map((v) => normalizePhone(String(v)));
    if (!candidatePhones.includes(phone)) continue;

    const first = (r.firstName ?? r.first_name ?? r.givenName) as string | undefined;
    const last = (r.lastName ?? r.last_name ?? r.familyName) as string | undefined;
    const fullName =
      ((r.name ?? r.fullName) as string | undefined) ??
      [first, last].filter(Boolean).join(' ');
    if (!fullName || !fullName.trim()) continue;

    return {
      name: fullName.trim(),
      firstName: first,
      lastName: last,
      company: (r.company ?? r.companyName ?? r.employer) as string | undefined,
      jobTitle: (r.jobTitle ?? r.title ?? r.position) as string | undefined,
      email: (r.email ?? r.emailAddress) as string | undefined,
      type: 'candidate',
    };
  }
  return null;
}

function flattenRows(payload: unknown): unknown[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object') return [];
  const r = payload as Record<string, unknown>;
  for (const key of ['candidates', 'contacts', 'data', 'rows', 'results', 'items']) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  // Single object response
  return [payload];
}
