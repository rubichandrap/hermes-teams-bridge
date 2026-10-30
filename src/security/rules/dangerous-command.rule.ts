import type { SecurityResult } from "../../types";
import type { ISecurityRule } from "./interface";

/**
 * Blocks dangerous system commands
 */
export class DangerousCommandRule implements ISecurityRule {
	private readonly patterns: RegExp[] = [
		/\bexec\b/,
		/\brm\s+-rf?\b/,
		/\bdelete\s+(the\s+)?(file|folder|directory|database|table|record)s?\b/,
		/\bremove\s+(the\s+)?(file|folder|directory|package|module)s?\b/,
		/\bformat\s+(the\s+)?(disk|drive|partition)s?\b/,
		/\bdestroy\s+(the\s+)?(server|system|database)s?\b/,
		/\bshutdown\b/,
		/\breboot\b/,
		/>\s*\/(etc|home|root|var|usr|bin|lib)/,
		/\bsudo\b/,
		/\bcurl\b.*\|.*\bsh\b/,
		/\bwget\b.*\|.*\bsh\b/,
		/\bpython\b.*-c\b/,
		/\bnode\b.*-e\b/,
		/\beval\b/,
		/\bdd\b.*if=.*of=/,
		/\bmkfs\b/,
		/>\s*\/dev\//,
		/\bpasswd\b.*-d/,
		/\busermod\b/,
		/\bgroups?\b.*-d/,
		/\bchmod\b.*777/,
		/\bchown\b.*root/,
		/\bnc\s+-[lke]/,
		/\bnetcat\b/,
		/\bnmap\b/,
		/\bssh\b.*\b(user|pass)/,
		/\bscp\b/,
		/\brsync\b.*--daemon/,
		/\bsystemctl\b/,
		/\bservice\b.*\b(start|stop|restart)/,
		/\bkill\b.*-9/,
		/\bpkill\b/,
		/\bkillall\b/,
		/\bdocker\b.*\b(run|exec)\b/,
		/\bkubectl\b/,
		/\bcat\b.*\.(env|secret|key|pem|config)/,
		/\bless\b.*\.(env|secret|key|pem)/,
	];

	scan(text: string): SecurityResult | null {
		const lower = text.toLowerCase();
		if (this.patterns.some((p) => p.test(lower))) {
			return {
				blocked: true,
				reason: "dangerous",
				warning:
					"⚠️ **SECURITY ALERT**\n\nPotentially dangerous command detected.\n\nExec/write/edit tools are disabled for Teams-originated sessions.\n\nUse the local webchat interface instead.",
			};
		}
		return null;
	}
}
