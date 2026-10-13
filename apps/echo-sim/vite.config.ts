import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The browser only ever talks to its own origin: /mcp is proxied to the MCP server, /brain to the
// Claude proxy. No CORS work, and the API key never reaches the page.
const cfg = JSON.parse(readFileSync(new URL('./sim.config.json', import.meta.url), 'utf8'));
const mcp = new URL(process.env.MCP_URL ?? cfg.mcpUrl);
const brain = process.env.BRAIN_URL ?? cfg.brainUrl;

export default defineConfig(({ command }) => ({
  // Relative asset paths in the build, so the same dist/ works under any prefix (served at /sim/ by the
  // shop-counter Lambda next to /mcp, /auth and /brain). API calls stay root-relative (/mcp, /brain/turn).
  base: command === 'build' ? './' : '/',
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
      // account linking (OAuth 2.1): discovery, registration, token. The consent page itself is opened
      // on the server's own origin (a top-level navigation), not through the proxy.
      '/.well-known/oauth-': { target: mcp.origin, changeOrigin: true },
      '/register': { target: mcp.origin, changeOrigin: true },
      '/token': { target: mcp.origin, changeOrigin: true },
      '/brain': { target: brain, changeOrigin: true },
    },
  },
  build: { target: 'es2022' },
}));
