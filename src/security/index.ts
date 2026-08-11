import type { SecurityResult } from "../types";
import { DangerousCommandRule } from "./rules/dangerous-command.rule";
import { FileWriteRule } from "./rules/file-write.rule";
import { IdentityFileRule } from "./rules/identity-file.rule";
import type { ISecurityRule } from "./rules/interface";

export class SecurityScanner {
	private readonly rules: ISecurityRule[];

	constructor(rules?: ISecurityRule[]) {
		this.rules = rules ?? [
			new DangerousCommandRule(),
			new IdentityFileRule(),
			new FileWriteRule(),
		];
	}

	scan(text: string): SecurityResult {
		for (const rule of this.rules) {
			const result = rule.scan(text);
			if (result) return result;
		}
		return { blocked: false };
	}

	addRule(rule: ISecurityRule): void {
		this.rules.push(rule);
	}
}

export type { ISecurityRule };
export { DangerousCommandRule, IdentityFileRule, FileWriteRule };
