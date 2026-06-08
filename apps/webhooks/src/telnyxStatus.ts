// v0.10.102 - Telnyx status poller + state cache + notification firer.

import { sendTenantTeamsCard } from './teamsNotifier.js';

interface StatuspageRoot {
  status?: { indicator?: string; description?: string };
  page?: { updated_at?: string };
}
interface StatuspageIncident {
  id?: string; name?: string; status?: string; impact?: string;
  created_at?: string; updated_at?: string; shortlink?: string;
}
interface IncidentsRoot { incidents?: StatuspageIncident[] }

const POLL_URL_STATUS = 'https://status.telnyx.com/api/v2/status.json';
const POLL_URL_INCIDENTS = 'https://status.telnyx.com/api/v2/incidents.json';
const POLL_INTERVAL_MS = 60_000;

type LogFn = (obj: Record<string, unknown>, msg: string) => void;
const defaultLog: LogFn = (o, m) => console.info(m, o);

export interface TelnyxStatus {
  indicator: string;
  description: string;
  updatedAt: string;
  fetchedAt: string;
  incidents: Array<{
    id: string; name: string; status: string; impact: string;
    createdAt: string; updatedAt: string; url: string;
  }>;
}

let current: TelnyxStatus = {
  indicator: 'none',
  description: 'Unknown (no poll yet)',
  updatedAt: new Date(0).toISOString(),
  fetchedAt: new Date(0).toISOString(),
  incidents: [],
};
let lastIndicator: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;

export function getTelnyxStatus(): TelnyxStatus { return current; }

async function fetchOnce(logger: LogFn): Promise<void> {
  try {
    // Status fetch is required; if it fails we abort the whole poll.
    const sRes = await fetch(POLL_URL_STATUS);
    if (!sRes.ok) throw new Error('status HTTP ' + sRes.status);
    const s = (await sRes.json()) as StatuspageRoot;

    // Incidents fetch is best-effort; failures shouldn't kill the poll.
    // Telnyx's /api/v2/incidents.json returns all recent incidents (resolved
    // + unresolved); we filter to unresolved client-side.
    let inc: IncidentsRoot = { incidents: [] };
    try {
      const iRes = await fetch(POLL_URL_INCIDENTS);
      if (iRes.ok) {
        const full = (await iRes.json()) as IncidentsRoot;
        inc = {
          incidents: (full.incidents ?? []).filter((i) => i.status !== 'resolved' && i.status !== 'postmortem'),
        };
      }
    } catch {
      /* incidents are optional - banner still works with just status */
    }
    const indicator = s.status?.indicator ?? 'none';
    const description = s.status?.description ?? 'Unknown';
    const updatedAt = s.page?.updated_at ?? new Date().toISOString();
    const incidents = (inc.incidents ?? []).map((i) => ({
      id: i.id ?? '',
      name: i.name ?? 'Unnamed incident',
      status: i.status ?? '',
      impact: i.impact ?? '',
      createdAt: i.created_at ?? '',
      updatedAt: i.updated_at ?? '',
      url: i.shortlink ?? 'https://status.telnyx.com',
    }));
    current = { indicator, description, updatedAt, fetchedAt: new Date().toISOString(), incidents };
    if (lastIndicator !== null && lastIndicator !== indicator) {
      const wasOk = lastIndicator === 'none';
      const isOk = indicator === 'none';
      if (wasOk && !isOk) {
        logger({ from: lastIndicator, to: indicator, description }, '[telnyx-status] DEGRADED');
        void notifyOutage(indicator, description, incidents).catch((e) => logger({ err: String(e) }, '[telnyx-status] notify failed'));
      } else if (!wasOk && isOk) {
        logger({ from: lastIndicator, to: indicator, description }, '[telnyx-status] RECOVERED');
        void notifyRecovery(description).catch((e) => logger({ err: String(e) }, '[telnyx-status] notify failed'));
      } else {
        logger({ from: lastIndicator, to: indicator, description }, '[telnyx-status] severity changed');
      }
    }
    lastIndicator = indicator;
  } catch (e) {
    logger({ err: e instanceof Error ? e.message : String(e) }, '[telnyx-status] poll failed');
  }
}

async function notifyOutage(indicator: string, description: string, incidents: TelnyxStatus['incidents']): Promise<void> {
  const summary = incidents.length > 0
    ? incidents.map((i) => '* ' + i.name + ' (' + i.status + ', ' + i.impact + ')').join('\n')
    : '(no active incidents listed yet)';
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: 'Telnyx service degraded', weight: 'Bolder', size: 'Large', color: 'Attention' },
          { type: 'TextBlock', text: 'Indicator: ' + indicator + ' - ' + description, wrap: true },
          { type: 'TextBlock', text: 'Active incidents:', weight: 'Bolder', spacing: 'Medium' },
          { type: 'TextBlock', text: summary, wrap: true, isSubtle: true },
        ],
        actions: [{ type: 'Action.OpenUrl', title: 'View status page', url: 'https://status.telnyx.com' }],
      },
    }],
  };
  await sendTenantTeamsCard(card, defaultLog).catch((e) => console.warn('[telnyx-status] teams send failed', e));
}

async function notifyRecovery(description: string): Promise<void> {
  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: 'Telnyx service recovered', weight: 'Bolder', size: 'Large', color: 'Good' },
          { type: 'TextBlock', text: 'Status: ' + description, wrap: true },
        ],
      },
    }],
  };
  await sendTenantTeamsCard(card, defaultLog).catch((e) => console.warn('[telnyx-status] teams send failed', e));
}

export function startTelnyxStatusPoller(logger?: LogFn): void {
  if (pollTimer) return;
  const log = logger ?? defaultLog;
  log({}, '[telnyx-status] starting poller (every 60s)');
  void fetchOnce(log);
  pollTimer = setInterval(() => { void fetchOnce(log); }, POLL_INTERVAL_MS);
}