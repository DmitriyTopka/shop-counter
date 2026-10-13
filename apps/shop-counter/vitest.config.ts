import { defineConfig } from 'vitest/config';

// Resolve shelf-to-alexa to its TypeScript source (see its package.json "shelf-source" export).
export default defineConfig({
  resolve: { conditions: ['shelf-source', 'import', 'node', 'default'] },
  ssr: { resolve: { conditions: ['shelf-source', 'import', 'node', 'default'], externalConditions: ['shelf-source'] } },
});
