// The "Alexa brain" system prompt, shared by both hosts that play Alexa+:
//   - apps/echo-sim/server/brain.mjs   (local proxy, Anthropic API)
//   - apps/shop-counter/src/brain.ts   (AWS Lambda, Amazon Bedrock)
// The persona is short; HOW to use the Shop Counter tools lives in the Agent Skill (SKILL.md next to this file),
// the same file a real Alexa+ / MCP host would load. Frontmatter is dropped, the body goes into the system prompt.
import { existsSync, readFileSync } from 'node:fs';

export const BASE = `You are Alexa+, talking through an Echo Show in the shopper's home. You help them shop one store's real catalog using the Shop Counter tools. Sound like a helpful store clerk, warm and plain. This is voice: one or two short sentences, under 35 words, no lists, no markdown, no URLs, no ids.`;

/** Agent Skill text -> { name, description, body }. Minimal frontmatter reader (key: value lines). */
export function parseSkill(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name: null, description: null, body: text.trim() };
  const meta = Object.fromEntries(m[1].split('\n').map((l) => l.match(/^(\w[\w-]*):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
  return { name: meta.name ?? null, description: meta.description ?? null, body: m[2].trim() };
}

/** Agent Skill file -> parsed skill, or null when the file is missing. */
export function loadSkill(file) {
  return file && existsSync(file) ? parseSkill(readFileSync(file, 'utf8')) : null;
}

/** The full system prompt: persona + the skill body inside <skill name="...">. Same bytes on both hosts. */
export function systemPrompt(skill) {
  return skill ? `${BASE}\n\n<skill name="${skill.name}">\n${skill.body}\n</skill>` : BASE;
}
