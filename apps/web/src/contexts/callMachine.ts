import { createMachine, assign } from 'xstate';
import { type CallEvent, type CallState } from '../services/sip';

export interface CallMachineContext {
  callState: CallEvent;
  incoming: CallEvent | null;
  hasSecondCall: boolean;
  secondCallNumber: string | null;
  secondCallId: string | null;
  conferenceActive: boolean;
  conferenceOtherNumber: string | null;
  conferenceOtherId: string | null;
  activeCallControlId: string | null;
  secondCallControlId: string | null;
}

export type CallMachineEvent =
  | { type: 'CALL_EVENT'; payload: CallEvent }
  | { type: 'UPDATE_ACTIVE_CC'; id: string | null }
  | { type: 'UPDATE_SECOND_CC'; id: string | null }
  | { type: 'SET_HELD_CALL'; number: string | null; id: string | null }
  | { type: 'SWAP_CALLS' }
  | { type: 'MERGE_CALLS' }
  | { type: 'CLEAR_INCOMING' };

export const callMachine = createMachine({
  id: 'call',
  initial: 'idle',
  context: {
    callState: { state: 'idle' as CallState },
    incoming: null,
    hasSecondCall: false,
    secondCallNumber: null,
    secondCallId: null,
    conferenceActive: false,
    conferenceOtherNumber: null,
    conferenceOtherId: null,
    activeCallControlId: null,
    secondCallControlId: null,
  } as CallMachineContext,
  states: {
    idle: {
      on: {
        CALL_EVENT: [
          {
            guard: ({ event }) => event.payload.state === 'incoming',
            target: 'ringing',
            actions: assign({
              incoming: ({ event }) => event.payload,
            }),
          },
          {
            guard: ({ event }) => event.payload.state === 'calling' || event.payload.state === 'ringing',
            target: 'dialing',
            actions: assign({
              callState: ({ event }) => event.payload,
            }),
          },
        ],
      },
    },
    dialing: {
      on: {
        CALL_EVENT: [
          {
            guard: ({ event }) => event.payload.state === 'connected',
            target: 'connected',
            actions: assign({
              callState: ({ event }) => event.payload,
            }),
          },
          {
            guard: ({ event }) => event.payload.state === 'ended',
            target: 'idle',
            actions: assign({
              callState: () => ({ state: 'idle' as CallState }),
            }),
          },
        ],
      },
    },
    ringing: {
      on: {
        CALL_EVENT: [
          {
            guard: ({ event }) => event.payload.state === 'connected',
            target: 'connected',
            actions: assign({
              callState: ({ event }) => event.payload,
              incoming: () => null,
            }),
          },
          {
            guard: ({ event }) => event.payload.state === 'ended',
            target: 'idle',
            actions: assign({
              incoming: () => null,
              callState: () => ({ state: 'idle' as CallState }),
            }),
          },
        ],
      },
    },
    connected: {
      on: {
        CALL_EVENT: [
          {
            // If the active call ended
            guard: ({ event, context }) => event.payload.state === 'ended' && event.payload.callId === context.callState.callId,
            target: 'checkingRemaining',
          },
          {
            // If another call ended (e.g. held call ended or incoming call ended)
            guard: ({ event, context }) => event.payload.state === 'ended' && event.payload.callId !== context.callState.callId,
            actions: assign({
              hasSecondCall: ({ context, event }) => {
                if (event.payload.callId === context.secondCallId) return false;
                return context.hasSecondCall;
              },
              secondCallNumber: ({ context, event }) => {
                if (event.payload.callId === context.secondCallId) return null;
                return context.secondCallNumber;
              },
              secondCallId: ({ context, event }) => {
                if (event.payload.callId === context.secondCallId) return null;
                return context.secondCallId;
              },
              secondCallControlId: ({ context, event }) => {
                if (event.payload.callId === context.secondCallId) return null;
                return context.secondCallControlId;
              },
              incoming: ({ context, event }) => {
                if (context.incoming && event.payload.callId === context.incoming.callId) return null;
                return context.incoming;
              },
              conferenceActive: ({ context }) => {
                if (context.conferenceActive) return false;
                return context.conferenceActive;
              },
              conferenceOtherNumber: ({ context }) => {
                if (context.conferenceActive) return null;
                return context.conferenceOtherNumber;
              },
              conferenceOtherId: ({ context }) => {
                if (context.conferenceActive) return null;
                return context.conferenceOtherId;
              },
            }),
          },
          {
            // Handle incoming calls while connected
            guard: ({ event }) => event.payload.state === 'incoming',
            actions: assign({
              incoming: ({ event }) => event.payload,
            }),
          },
          {
            // Handle connected event updates (like remote stream/call info changes)
            guard: ({ event }) => event.payload.state === 'connected',
            actions: assign({
              callState: ({ event }) => event.payload,
            }),
          },
        ],
        UPDATE_ACTIVE_CC: {
          actions: assign({
            activeCallControlId: ({ event }) => event.id,
          }),
        },
        UPDATE_SECOND_CC: {
          actions: assign({
            secondCallControlId: ({ event }) => event.id,
          }),
        },
        SET_HELD_CALL: {
          actions: assign({
            hasSecondCall: () => true,
            secondCallNumber: ({ event }) => event.number,
            secondCallId: ({ event }) => event.id,
            secondCallControlId: ({ context }) => context.activeCallControlId,
            activeCallControlId: () => null,
            incoming: () => null,
          }),
        },
        SWAP_CALLS: {
          actions: assign({
            callState: ({ context }) => ({
              state: 'connected' as CallState,
              callId: context.secondCallId ?? undefined,
              number: context.secondCallNumber ?? undefined,
            }),
            secondCallNumber: ({ context }) => context.callState.number ?? null,
            secondCallId: ({ context }) => context.callState.callId ?? null,
            activeCallControlId: ({ context }) => context.secondCallControlId,
            secondCallControlId: ({ context }) => context.activeCallControlId,
          }),
        },
        MERGE_CALLS: {
          actions: assign({
            hasSecondCall: () => false,
            secondCallNumber: () => null,
            secondCallControlId: () => null,
            conferenceActive: () => true,
            conferenceOtherNumber: ({ context }) => context.secondCallNumber,
            conferenceOtherId: ({ context }) => context.secondCallId,
          }),
        },
        CLEAR_INCOMING: {
          actions: assign({
            incoming: () => null,
          }),
        },
      },
    },
    checkingRemaining: {
      always: [
        {
          guard: ({ context }) => context.secondCallId !== null,
          target: 'connected',
          actions: assign({
            callState: ({ context }) => ({
              state: 'connected' as CallState,
              callId: context.secondCallId ?? undefined,
              number: context.secondCallNumber ?? undefined,
            }),
            hasSecondCall: () => false,
            secondCallNumber: () => null,
            secondCallId: () => null,
            activeCallControlId: ({ context }) => context.secondCallControlId,
            secondCallControlId: () => null,
            conferenceActive: () => false,
            conferenceOtherNumber: () => null,
            conferenceOtherId: () => null,
          }),
        },
        {
          target: 'idle',
          actions: assign({
            callState: () => ({ state: 'idle' as CallState }),
            hasSecondCall: () => false,
            secondCallNumber: () => null,
            secondCallId: () => null,
            conferenceActive: () => false,
            conferenceOtherNumber: () => null,
            conferenceOtherId: () => null,
            activeCallControlId: () => null,
            secondCallControlId: () => null,
          }),
        },
      ],
    },
  },
});
