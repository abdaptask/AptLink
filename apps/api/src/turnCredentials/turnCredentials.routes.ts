// v0.9.13 — GET /turn-credentials
//
// Returns a list of TURN/STUN ICE servers for the client to layer on top
// of the always-on Telnyx TURN that's hardcoded in sip.ts.
//
// Today the only "extra" provider we support is Cloudflare TURN. When the
// CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN env vars are set on
// this api service, this endpoint mints a short-lived (1 hour) Cloudflare
// TURN credential and returns it. When the vars aren't set, the endpoint
// returns an empty list and the client falls back to Telnyx-TURN-only
// (which handles ~95% of behind-NAT users on its own).
//
// Why mint per-request:
//   Cloudflare TURN credentials are time-bound — we don't put a static
//   credential in the browser (would leak our long-lived API token).
//   Instead the API holds the token, mints a 1-hour credential, and
//   hands the short-lived one to the client. SipContext will re-fetch
//   on reconnect to keep TURN warm during long sessions.
//
// Auth: requires a valid ACE JWT (same as every other authenticated
// endpoint). Without auth we'd be exposing TURN credentials to anyone
// who finds the URL.

import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * Cloudflare's TURN credential generation response shape. We re-shape it
 * into RFC-7064 RTCIceServer entries the browser PeerConnection accepts.
 *
 * Cloudflare returns:
 *   {
 *     iceServers: {
 *       urls: ["stun:..."|"turn:..."|"turns:..."],
 *       username: "...",
 *       credential: "...",
 *     }
 *   }
 *
 * Note: the shape lists urls as an array — same as RTCIceServer's standard
 * format — so we can pass it through almost unchanged.
 */
interface CloudflareTurnResponse {
  iceServers?: {
    urls: string | string[];
    username?: string;
    credential?: string;
  };
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export async function turnCredentialsRoutes(app: FastifyInstance) {
  app.get(
    '/turn-credentials',
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { cloudflareTurnKeyId, cloudflareTurnApiToken } = config;

      // Not configured — return empty list. Client falls back to Telnyx TURN.
      if (!cloudflareTurnKeyId || !cloudflareTurnApiToken) {
        return { iceServers: [] as IceServer[], provider: 'none' };
      }

      try {
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${cloudflareTurnKeyId}/credentials/generate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cloudflareTurnApiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ttl: 3600 }), // 1 hour
          },
        );
        if (!res.ok) {
          const errBody = await res.text();
          request.log.warn(
            { status: res.status, body: errBody },
            '[turn-credentials] Cloudflare API rejected',
          );
          // Don't fail the request — gracefully fall back to no Cloudflare.
          // The client still has Telnyx TURN.
          return { iceServers: [] as IceServer[], provider: 'cloudflare-error' };
        }
        const data = (await res.json()) as CloudflareTurnResponse;
        if (!data.iceServers) {
          return { iceServers: [] as IceServer[], provider: 'cloudflare-empty' };
        }
        // Cloudflare returns a single iceServers object (with the urls array
        // and shared username/credential). The browser RTCIceServer type
        // accepts that same shape, so we just normalize it into an array.
        const iceServers: IceServer[] = [{
          urls: data.iceServers.urls,
          username: data.iceServers.username,
          credential: data.iceServers.credential,
        }];
        return { iceServers, provider: 'cloudflare' };
      } catch (e) {
        request.log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          '[turn-credentials] Cloudflare fetch threw',
        );
        return reply
          .code(200)
          .send({ iceServers: [] as IceServer[], provider: 'cloudflare-throw' });
      }
    },
  );
}
