import type { SecurityResult } from "../../types";
import type { ISecurityRule } from "./interface";

/**
 * Blocks modifications to core identity files
 */
export class IdentityFileRule implements ISecurityRule {
	private readonly patterns: RegExp[] = [
		/\b(soul|identity|agents)\.md\b/,
		/\b(edit|update|change|modify|rewrite|write)\b.{0,30}\b(soul|identity|agents)\b/,
		/\b(soul|identity|agents)\b.{0,30}\b(edit|update|change|modify|rewrite|write)\b/,
		/\b(edit|update|change|modify|rewrite|write)\b.{0,30}\b(persona|who\s+you\s+are|saya\s+siapa|identitas|karakter|personality)\b/,
		/\b(edit|update|change|modify|rewrite|write)\b.{0,30}\b(config\.json|openclaw\.json|settings)\b/,
		/\b\.(json|config)\b.{0,20}\b(edit|update|change|modify|rewrite|write)\b/,
	];

	scan(text: string): SecurityResult | null {
		const lower = text.toLowerCase();
		if (this.patterns.some((p) => p.test(lower))) {
			return {
				blocked: true,
				reason: "persona",
				warning:
					"⚠️ **SECURITY: Identity Protection**\n\nCore config files (SOUL.md, IDENTITY.md, AGENTS.md, *.json) are protected.\n\nOnly Rubi Chandraputra (main webchat) can modify identity settings.",
			};
		}
		return null;
	}
}
