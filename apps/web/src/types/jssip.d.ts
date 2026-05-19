// Minimal JsSIP type stubs. The official package ships JSDoc-only.
// We only declare the surface we actually use in sip.ts; everything else is
// `any`. Upgrade to a fuller typedef later if needed.
declare module 'jssip' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const WebSocketInterface: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const UA: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type UA = any;
  const JsSIP: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketInterface: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    UA: any;
  };
  export default JsSIP;
}
