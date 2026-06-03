// v0.10.59 — Reusable "send an SMS/MMS now" helper.
//
// Extracted from the POST /messages route so both the immediate-send path
// and the scheduled-message worker can hand a message to Telnyx through
// the same codepath. Keeping both paths on one function avoids drift —
// e.g. fixing a Telnyx field on one path automatically fixes the other.
//
// Returns a discriminated result. Callers decide what to do on failure
// (HTTP 502 from the route, retry counter bump from the worker, etc).
import { prisma } from '@ace/db';
import { config } from '../config.js';

export type SendMessageOk = {
  ok: true;
  message: {
    id: number;
    telnyxMessageId: string;
    fromNumber: string;
    toNumber: string;
    status: string;
    userDidId: number | null;
  };
};

export type SendMessageErr = {
  ok: false;
  /** Short stable code for the route/worker to branch on. */
  code:
    | 'no_did_assigned'
    | 'telnyx_send_failed'
    | 'telnyx_request_failed'
    | 'config_missing';
  /** Human-readable for UI / audit. */
  message: string;
  /** Telnyx error envelope for diagnostics (when applicable). */
  detail?: unknown;
};

export type SendMessageResult = SendMessageOk | SendMessageErr;

export interface SendMessageInput {
  userId: number;
  /** E.164-normalized recipient. */
  toNumber: string;
  /** Text body. Empty string allowed when mediaUrls is non-empty. */
  body: string;
  /** MMS attachment URLs (public). Empty array = SMS only. */
  mediaUrls: string[];
  /**
   * Optional: pin the outbound DID. Used by the scheduled-message worker
   * to honor the DID the user had selected when they scheduled the message
   * (even if their active DID has changed since). When NULL/undefined, the
   * helper resolves activeUserDidId → first default DID, same as the
   * immediate POST /messages route.
   */
  forcedUserDidId?: number | null;
}

export async function sendMessageImmediate(
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const { userId, toNumber, body, mediaUrls, forcedUserDidId } = input;

  if (!config.telnyxApiKey) {
    return {
      ok: false,
      code: 'config_missing',
      message: 'TELNYX_API_KEY not configured on server',
    };
  }

  // Resolve the user's FROM number. Same fallback chain as the immediate
  // route (active → default), unless caller forced a specific UserDid.
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      activeUserDidId: true,
      userDids: {
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, didNumber: true, isDefault: true },
      },
    },
  });

  let fromNumber: string | null = null;
  let fromUserDidId: number | null = null;

  if (forcedUserDidId) {
    // Worker case: honor the DID captured at schedule time.
    const forced = dbUser?.userDids.find((d) => d.id === forcedUserDidId);
    if (forced) {
      fromNumber = forced.didNumber;
      fromUserDidId = forced.id;
    }
    // Falls through to default-DID resolution if the captured DID no
    // longer exists (e.g. admin removed it between schedule and send).
  }

  if (!fromNumber && dbUser?.activeUserDidId) {
    const active = dbUser.userDids.find((d) => d.id === dbUser.activeUserDidId);
    if (active) {
      fromNumber = active.didNumber;
      fromUserDidId = active.id;
    }
  }
  if (!fromNumber && dbUser?.userDids?.length) {
    fromNumber = dbUser.userDids[0].didNumber;
    fromUserDidId = dbUser.userDids[0].id;
  }
  if (!fromNumber) {
    return {
      ok: false,
      code: 'no_did_assigned',
      message:
        'User has no phone number (DID) assigned. Ask an admin to assign one in Users → your row before sending SMS.',
    };
  }

  // Call Telnyx.
  const telnyxBody: Record<string, unknown> = {
    from: fromNumber,
    to: toNumber,
    text: body,
  };
  if (mediaUrls.length > 0) telnyxBody.media_urls = mediaUrls;

  let telnyxResponse: { id?: string; status?: string; errors?: unknown } = {};
  try {
    const res = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.telnyxApiKey}`,
      },
      body: JSON.stringify(telnyxBody),
    });
    const json = (await res.json()) as { data?: typeof telnyxResponse; errors?: unknown };
    if (!res.ok) {
      return {
        ok: false,
        code: 'telnyx_send_failed',
        message: `Telnyx HTTP ${res.status}`,
        detail: json.errors,
      };
    }
    telnyxResponse = json.data ?? {};
  } catch (e) {
    return {
      ok: false,
      code: 'telnyx_request_failed',
      message: (e as Error).message ?? 'network error talking to Telnyx',
    };
  }

  const telnyxMessageId = telnyxResponse.id ?? `local-${Date.now()}`;
  const saved = await prisma.message.create({
    data: {
      userId,
      telnyxMessageId,
      threadKey: toNumber,
      direction: 'outbound',
      fromNumber,
      toNumber,
      body,
      mediaUrls,
      status: telnyxResponse.status ?? 'queued',
      userDidId: fromUserDidId,
      sentAt: new Date(),
    },
    select: {
      id: true,
      telnyxMessageId: true,
      fromNumber: true,
      toNumber: true,
      status: true,
      userDidId: true,
    },
  });

  return {
    ok: true,
    message: saved,
  };
}
