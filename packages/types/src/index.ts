export type EventType = 'missed_call' | 'sms' | 'voicemail';

export interface TelnyxCallJobPayload {
  eventType: string;
  payload: any;
}

export interface TelnyxSmsJobPayload {
  eventType: string;
  payload: any;
}

export interface TelnyxVoicemailJobPayload {
  fromNumber: string;
  toNumber?: string;
  recordingUrl: string;
  durationSeconds: number;
  telnyxCallId?: string;
  receivedAt: string; // serialized Date
  transcription?: string;
  connectionId?: string;
  source: 'hosted-vm' | 'texml-vm';
}

export interface TelnyxVoicemailCcJobPayload {
  event: any;
}

export type TelnyxJob =
  | { type: 'call'; data: TelnyxCallJobPayload }
  | { type: 'sms'; data: TelnyxSmsJobPayload }
  | { type: 'voicemail'; data: TelnyxVoicemailJobPayload }
  | { type: 'voicemail-cc'; data: TelnyxVoicemailCcJobPayload };
