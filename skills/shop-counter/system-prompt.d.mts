export interface Skill { name: string | null; description: string | null; body: string }
export declare const BASE: string;
export declare function parseSkill(text: string): Skill;
export declare function loadSkill(file: string | undefined | null): Skill | null;
export declare function systemPrompt(skill: Skill | null): string;
