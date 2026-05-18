// Centralised env-var loading. Missing required vars cause a fast failure
// on boot rather than a confusing runtime crash later.

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '3000')),
  logLevel: optional('LOG_LEVEL', 'info'),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '24h'),
  allowedOrigins: optional('ALLOWED_ORIGINS', '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Telnyx server-side API
  telnyxApiKey: optional('TELNYX_API_KEY'),
  telnyxMessagingProfileId: optional('TELNYX_MESSAGING_PROFILE_ID'),
  // Call Control Application "connection_id" — needed to originate calls via
  // POST /v2/calls. Look this up in the Telnyx portal under Voice → Programmable
  // Voice → Call Control Apps → <your app> → API ID.
  telnyxCcConnectionId: optional('TELNYX_CC_CONNECTION_ID'),
  pilotFromNumber: optional('PILOT_TELNYX_NUMBER', '+17322001305'),

  // Supabase Storage (for MMS uploads)
  supabaseUrl: optional('SUPABASE_URL'),
  supabaseServiceKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseMediaBucket: optional('SUPABASE_MEDIA_BUCKET', 'ace-media'),

  // JobDiva (Phase 5.5 — contact lookup)
  jobDivaBaseUrl: optional('JOBDIVA_BASE_URL'),
  jobDivaUsername: optional('JOBDIVA_USERNAME'),
  jobDivaPassword: optional('JOBDIVA_PASSWORD'),
  jobDivaClientId: optional('JOBDIVA_CLIENT_ID'),
};
