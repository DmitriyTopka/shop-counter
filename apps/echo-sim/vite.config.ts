import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The browser only ever talks to its own origin: /mcp is proxied to the MCP server, /brain to the
// Claude proxy. No CORS work, and the API key never reaches the page.
const cfg = JSON.parse(readFileSync(new URL('./sim.config.json', import.meta.url), 'utf8'));
const mcp = new URL(process.env.MCP_URL ?? cfg.mcpUrl);
const brain = process.env.BRAIN_URL ?? cfg.brainUrl;

export default defineConfig({
  define: { __SIM_CONFIG__: JSON.stringify({ ...cfg, mcpUrl: mcp.href }) },
  server: {
    port: Number(process.env.SIM_PORT ?? 5180),
    strictPort: true,
    proxy: {
      '/mcp': { target: mcp.origin, changeOrigin: true, rewrite: () => mcp.pathname + mcp.search },
      // per-store endpoints of apps/shop-counter, e.g. /stores/roborock/mcp
      '/stores': { target: mcp.origin, changeOrigin: true },
      // demo sign-in: the server signs a session token for the profile (see apps/shop-counter app.ts)
      '/auth': { target: mcp.origin, changeOrigin: true },
      '/brain': { target: brain, changeOrigin: true },
    },
  },
  build: { target: 'es2022' },
});
