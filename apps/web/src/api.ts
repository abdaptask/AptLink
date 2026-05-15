
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

export interface CreateCallInput {
  telnyxCallId: string;
  direction?: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  status?: string;
  startedAt?: string;
}

export async function createCall(token: string, input: CreateCallInput): Promise<CallRecord> {
  const res = await fetch(`${API_URL}/calls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface UpdateCallInput {
  status?: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number;
  hangupCause?: string | null;
}

export async function updateCall(
  token: string,
  idOrTelnyxCallId: string | number,
  input: UpdateCallInput
): Promise<CallRecord> {
  const res = await fetch(`${API_URL}/calls/${idOrTelnyxCallId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}


// ---------- Phase 5.3: Messages ----------
export interface MessageRecord {
  id: number;
  telnyxMessageId: string;
  threadKey: string;
  direction: 'inbound' | 'outbound' | string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls: string[];
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ThreadSummary {
  id: number;
  threadKey: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  mediaUrls: string[];
  status: string;
  createdAt: string;
}

export async function getThreads(token: string): Promise<ThreadSummary[]> {
  const res = await fetch(`${API_URL}/messages/threads`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getThread(token: string, number: string): Promise<MessageRecord[]> {
  const res = await fetch(
    `${API_URL}/messages/threads/${encodeURIComponent(number)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface SendMessageInput {
  to: string;
  body?: string;
  mediaUrls?: string[];
}

export async function sendMessage(token: string, input: SendMessageInput): Promise<MessageRecord> {
  const res = await fetch(`${API_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'send failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function uploadMedia(token: string, file: File): Promise<{ url: string }> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result as string;
      // strip "data:image/jpeg;base64," prefix
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  const res = await fetch(`${API_URL}/messages/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      dataBase64,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'upload failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}
