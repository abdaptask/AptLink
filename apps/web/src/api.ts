
const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ||
  'https://ace-dialer-api.onrender.com';

export interface User {
  id: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isAdmin: boolean;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface CallRecord {
  id: number;
  telnyxCallId: string;
  direction: 'inbound' | 'outbound' | string;
  fromNumber: string;
  toNumber: string;
  status: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  hangupCause: string | null;
  recordingUrl: string | null;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Login failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getMe(token: string): Promise<User> {
  const res = await fetch(`${API_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getCalls(token: string): Promise<CallRecord[]> {
  const res = await fetch(`${API_URL}/calls`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
