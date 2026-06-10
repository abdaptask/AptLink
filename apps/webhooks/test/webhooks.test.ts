import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Setup mock modules BEFORE importing app
vi.mock('bullmq', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'mock-job-id' });
  return {
    Queue: class {
      add = mockQueueAdd;
    },
    mockQueueAdd,
  };
});

vi.mock('@ace/db', () => {
  return {
    prisma: {
      userDid: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 1,
            didNumber: '+17322001305',
            connectionId: 'mock-connection-id',
            userId: 1,
          },
        ]),
        update: vi.fn().mockResolvedValue({ id: 1 }),
      },
    },
  };
});

// Mock lookupDidOwner helper from texmlVoicemail
vi.mock('../src/texmlVoicemail.js', () => {
  return {
    buildDialTeXML: vi.fn().mockReturnValue('<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Sip>sip:mock-user@sip.telnyx.com</Sip></Dial></Response>'),
    buildVoicemailTeXML: vi.fn().mockReturnValue('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Voicemail greeting</Say></Response>'),
    buildDialStatusTeXML: vi.fn().mockReturnValue('<?xml version="1.0" encoding="UTF-8"?><Response><Record/></Response>'),
    lookupDidOwner: vi.fn().mockResolvedValue({
      userDidId: 1,
      userId: 1,
      sipUsername: 'mock-user',
      firstName: 'Alice',
      greeting: { mode: 'tts', url: null, text: 'Hello' },
    }),
  };
});

// Import the app. By now fastify and queue should resolve to mocked versions
import { app, webhookQueue } from '../src/app.js';

describe('ACE Webhooks Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET / should return service status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/',
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.payload);
    expect(json.service).toBe('ace-dialer-webhooks');
    expect(json.status).toBe('ok');
  });

  it('GET /health should return 200 OK', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.payload);
    expect(json.status).toBe('ok');
  });

  it('POST /webhooks/telnyx/voicemail-cc should enqueue job and return received: true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/telnyx/voicemail-cc',
      payload: {
        data: {
          event_type: 'call.speak.started',
          payload: { call_control_id: 'cc-123' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ received: true });
    expect(webhookQueue.add).toHaveBeenCalledWith('voicemail-cc', expect.any(Object));
  });

  it('POST /webhooks/telnyx/calls should enqueue job and return received: true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/telnyx/calls',
      payload: {
        data: {
          event_type: 'call.initiated',
          payload: { call_control_id: 'cc-abc', call_session_id: 'session-xyz' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ received: true });
    expect(webhookQueue.add).toHaveBeenCalledWith('call', {
      eventType: 'call.initiated',
      payload: { call_control_id: 'cc-abc', call_session_id: 'session-xyz' },
    });
  });

  it('POST /webhooks/telnyx/sms should enqueue sms job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/telnyx/sms',
      payload: {
        data: {
          event_type: 'message.received',
          payload: { id: 'msg-123', text: 'Hello' },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ received: true });
    expect(webhookQueue.add).toHaveBeenCalledWith('sms', {
      eventType: 'message.received',
      payload: { id: 'msg-123', text: 'Hello' },
    });
  });

  it('POST /texml/inbound should route calls to resolved DID connection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/texml/inbound',
      payload: {
        To: '+17322001305',
        From: '+17325550199',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.payload).toContain('<Sip>sip:mock-connection-id@sip.telnyx.com</Sip>');
  });

  it('POST /texml/dial-status should return busy status XML on busy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/texml/dial-status',
      payload: {
        DialCallStatus: 'busy',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('on another call. Please try again');
  });

  it('POST /texml/voicemail/recording-complete should enqueue voicemail to queue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/texml/voicemail/recording-complete',
      payload: {
        From: '+17325550199',
        To: '+17322001305',
        RecordingUrl: 'https://example.com/recording.mp3',
        RecordingDuration: '10',
        CallSid: 'sid-123',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('<Response/>');
    expect(webhookQueue.add).toHaveBeenCalledWith('voicemail', {
      fromNumber: '+17325550199',
      toNumber: '+17322001305',
      recordingUrl: 'https://example.com/recording.mp3',
      durationSeconds: 10,
      telnyxCallId: 'sid-123',
      receivedAt: expect.any(String),
      source: 'texml-vm',
    });
  });
});
