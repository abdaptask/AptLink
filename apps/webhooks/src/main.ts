// ACE Dialer Webhooks — Server entry point.
import { app } from './app.js';
import { startTelnyxStatusPoller } from './telnyxStatus.js';
import { ensureTeXMLApp } from './texmlVoicemail.js';

const SERVICE_NAME = 'ace-dialer-webhooks';
const TELNYX_API_KEY = process.env.TELNYX_API_KEY ?? '';
const port = Number(process.env.PORT ?? 3002);
const host = '0.0.0.0';

try {
  startTelnyxStatusPoller((obj, msg) => app.log.info(obj, msg));

  (async () => {
    try {
      if (!TELNYX_API_KEY) {
        app.log.warn({}, '[texml-vm] TELNYX_API_KEY not set - skipping TeXML App bootstrap');
        return;
      }
      const publicBase = (process.env.WEBHOOKS_PUBLIC_URL ?? '').trim();
      if (!publicBase) {
        app.log.warn({}, '[texml-vm] WEBHOOKS_PUBLIC_URL not set - skipping TeXML App bootstrap');
        return;
      }
      const appId = await ensureTeXMLApp({
        telnyxApiKey: TELNYX_API_KEY,
        publicBaseUrl: publicBase,
        log: (o, m) => app.log.info(o, m),
      });
      app.log.info({ appId }, '[texml-vm] TeXML App ready');
    } catch (err) {
      app.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[texml-vm] TeXML App bootstrap failed - voicemail trial migration will not work until resolved',
      );
    }
  })();

  await app.listen({ port, host });
  app.log.info({ port, host }, `[${SERVICE_NAME}] listening`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, `[${SERVICE_NAME}] shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
