import type { SecurityResult } from "../../types";
import type { ISecurityRule } from "./interface";

/**
 * Blocks file/folder write operations from Teams
 */
export class FileWriteRule implements ISecurityRule {
	private readonly patterns: RegExp[] = [
		/\b(write|edit|update|change|modify|rewrite|create|make|mkdir|touch|append|overwrite)\b.{0,40}\b(file|folder|directory|path|\.txt|\.json|\.js|\.ts|\.py|\.sh|\.yml|\.yaml|\.md|\.html|\.css)\b/,
		/\b(file|folder|directory|path)\b.{0,40}\b(write|edit|update|change|modify|rewrite|create|make|mkdir|touch|append|overwrite)\b/,
		/\b(apply_patch|edit_tool|write_file|create_file|update_file|modify_file)\b/,
		/\b(~\/|\/home\/|\/etc\/|\/usr\/|\/var\/|\/opt\/)[^\s]*\.(txt|json|js|ts|py|sh|yml|yaml|html|css|conf)/,
		/\bmemory\.md\b/,
		/\b(edit|update|change|modify|rewrite|write)\b.{0,30}\bmemory\b/,
	];

	scan(text: string): SecurityResult | null {
		const lower = text.toLowerCase();
		if (this.patterns.some((p) => p.test(lower))) {
			return {
				blocked: true,
				reason: "filewrite",
				warning:
					"⚠️ **SECURITY: File Access Denied**\n\nTeams chat cannot create, edit, or delete files.\n\nOnly Rubi Chandraputra (main webchat) can modify files, including MEMORY.md.",
			};
		}
		return null;
	}
}
