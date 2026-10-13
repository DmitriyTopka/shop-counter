// MCP Apps host side: renders a tool's ui:// resource in a sandboxed iframe and wires it with AppBridge.
// One iframe per resource URI is kept alive; a new result for the same view is pushed into it
// (ui/notifications/tool-input + tool-result) instead of reloading, so screens change without a flash.
import type { Client } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport, buildAllowAttribute } from '@modelcontextprotocol/ext-apps/app-bridge';
import { LoggingTransport, type LogFn } from './logging-transport';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface HostHooks {
  log: LogFn;
  /** a tools/call made by the view (button tap). Must perform it and return the result. */
  onViewToolCall: (name: string, args: Record<string, unknown>) => Promise<any>;
  /** ui/update-model-context from the view (e.g. cards the shopper marked). Latest one wins. */
  onModelContext?: (params: { content?: any[]; structuredContent?: Record<string, unknown> }) => void;
}

const HOST_INFO = { name: 'ShopCounter EchoShow Simulator', version: '0.1.0' };

export class AppHost {
  private bridge: AppBridge | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private uri = '';
  private ready: Promise<void> = Promise.resolve();
  private htmlCache = new Map<string, { html: string; meta: any }>();

  constructor(private slot: HTMLElement, private hooks: HostHooks) {}

  reset() {
    this.teardown();
    this.htmlCache.clear();
  }

  private teardown() {
    const b = this.bridge;
    this.bridge = null;
    if (b) { b.teardownResource({}).catch(() => {}).finally(() => b.close().catch(() => {})); }
    this.iframe?.remove();
    this.iframe = null;
    this.uri = '';
  }

  async show(client: Client, uri: string, args: Record<string, unknown>, result: any) {
    if (this.uri !== uri || !this.bridge) await this.mount(client, uri);
    await this.ready;
    await this.bridge!.sendToolInput({ arguments: args });
    await this.bridge!.sendToolResult(result);
  }

  private async load(client: Client, uri: string) {
    const hit = this.htmlCache.get(uri);
    if (hit) return hit;
    const res = await client.readResource({ uri });
    const c: any = res.contents[0];
    const html = c.text ?? new TextDecoder().decode(Uint8Array.from(atob(c.blob), (ch) => ch.charCodeAt(0)));
    const out = { html, meta: c._meta?.ui ?? {} };
    this.htmlCache.set(uri, out);
    return out;
  }

  private async mount(client: Client, uri: string) {
    this.teardown();
    const { html, meta } = await this.load(client, uri);
    const iframe = document.createElement('iframe');
    // Scripts yes, same-origin no: the view lives in an opaque origin and cannot touch the host page.
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', 'Shop Counter app');
    const allow = buildAllowAttribute(meta.permissions);
    if (allow) iframe.setAttribute('allow', allow);
    this.slot.replaceChildren(iframe);

    const rect = this.slot.getBoundingClientRect();
    const bridge = new AppBridge(client, HOST_INFO, { serverTools: {}, openLinks: {}, logging: {}, updateModelContext: { text: {} } } as any, {
      hostContext: {
        theme: 'dark',
        displayMode: 'inline',
        availableDisplayModes: ['inline'],
        platform: 'web',
        deviceCapabilities: { touch: true, hover: false },
        containerDimensions: { width: Math.round(rect.width), maxHeight: Math.round(rect.height) },
        locale: 'en-US',
        userAgent: 'EchoShowSimulator/0.1',
      } as any,
    });
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    bridge.oninitialized = () => resolveReady();
    bridge.onmessage = async (p: any) => {
      this.hooks.log('<-', { note: 'ui/message from view', content: p?.content });
      return {};
    };
    bridge.onopenlink = async () => ({ isError: true }) as any; // a voice device does not open web pages
    bridge.onupdatemodelcontext = async (p: any) => {
      this.hooks.onModelContext?.(p ?? {});
      return {};
    };
    const pm = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!);
    await bridge.connect(new LoggingTransport(pm, this.hooks.log) as any);
    // Route the view's tools/call through the simulator (logs it, updates screen state, speaks the reply).
    // connect() installs a plain forwarder; we replace it on purpose.
    const prevWarn = console.warn;
    console.warn = () => {};
    bridge.oncalltool = async (params: any) => this.hooks.onViewToolCall(params.name, params.arguments ?? {});
    console.warn = prevWarn;
    this.bridge = bridge;
    this.iframe = iframe;
    this.uri = uri;
    iframe.srcdoc = html; // load only after the bridge listens
  }
}
