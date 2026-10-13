// Wraps any MCP Transport and reports every JSON-RPC message in both directions (ported from spike/src/shared).
/* eslint-disable @typescript-eslint/no-explicit-any */
export type LogFn = (dir: '->' | '<-' | '!!', msg: unknown) => void;

export class LoggingTransport {
  onmessage?: (m: any, extra?: any) => void;
  onerror?: (e: Error) => void;
  onclose?: () => void;
  constructor(private inner: any, private log: LogFn) {}
  async start() {
    this.inner.onmessage = (m: any, extra: any) => { this.log('<-', m); this.onmessage?.(m, extra); };
    this.inner.onerror = (e: any) => { this.log('!!', { error: String(e?.message ?? e) }); this.onerror?.(e); };
    this.inner.onclose = () => this.onclose?.();
    return this.inner.start();
  }
  async send(message: any, options?: any) { this.log('->', message); return this.inner.send(message, options); }
  async close() { return this.inner.close(); }
  get sessionId() { return this.inner.sessionId; }
  set sessionId(v) { this.inner.sessionId = v; }
  setProtocolVersion(v: string) { this.inner.setProtocolVersion?.(v); }
  get protocolVersion() { return this.inner.protocolVersion; }
}
