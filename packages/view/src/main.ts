// MCP App entry. Runs inside the host's sandboxed iframe and talks to the host only via postMessage
// (ext-apps `App`). Every structuredContent kind is drawn by render.ts.
import { App } from '@modelcontextprotocol/ext-apps';
import { renderResult, renderWaiting } from './render';
import type { ToolResultLike, ViewHost } from './types';

const root = document.getElementById('root')!;

function mount(el: HTMLElement) {
  root.replaceChildren(el);
  root.scrollTop = 0;
}

const app = new App({ name: 'ShopCounterView', version: '0.1.0' }, {});

const host: ViewHost = {
  callTool: (name, args) => app.callServerTool({ name, arguments: args }) as Promise<ToolResultLike>,
  show: (r) => mount(renderResult(r, host)),
  // Marked cards -> host model context. Only the latest update counts (spec), so an empty list clears it.
  select: (products) => {
    const text = products.length
      ? `On screen the shopper marked ${products.length} product${products.length === 1 ? '' : 's'}: ${products.map((p) => `${p.title} (id ${p.id})`).join('; ')}. "Compare them" means these.`
      : 'The shopper cleared the marked products.';
    app
      .updateModelContext({ content: [{ type: 'text', text }], structuredContent: { selected_ids: products.map((p) => p.id) } })
      .catch((e) => console.warn('[view] host did not take the selection', e));
  },
};

app.ontoolinput = (p) => {
  const a = (p.arguments ?? {}) as Record<string, unknown>;
  const need = typeof a.need === 'string' ? a.need : '';
  mount(renderWaiting(need ? `Looking for “${need}”…` : 'Working on it…'));
};
app.ontoolresult = (r) => host.show(r as ToolResultLike);
app.onhostcontextchanged = (ctx) => applyContext(ctx as Record<string, unknown>);

function applyContext(ctx: Record<string, unknown> | undefined) {
  if (!ctx) return;
  const theme = ctx.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  const dims = ctx.containerDimensions as { maxHeight?: number } | undefined;
  if (dims?.maxHeight) document.documentElement.style.setProperty('--max-h', `${dims.maxHeight}px`);
}

// Designed at 1280 px (Echo Show 8). Wider or narrower screens scale the whole layout, so type stays
// readable across the room on an Echo Show 15 and nothing overflows on a smaller frame.
function fitZoom() {
  const w = window.innerWidth;
  document.documentElement.style.zoom = String(w >= 600 ? Math.min(1.6, w / 1280) : 1);
}
addEventListener('resize', fitZoom);
fitZoom();

mount(renderWaiting());
await app.connect();
applyContext(app.getHostContext() as Record<string, unknown> | undefined);
