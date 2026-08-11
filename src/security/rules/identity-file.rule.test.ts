import { describe, expect, it } from "vitest";
import { IdentityFileRule } from "./identity-file.rule";

const rule = new IdentityFileRule();

describe("IdentityFileRule", () => {
	describe("blocks", () => {
		const positives: Array<[string, string]> = [
			["soul.md", "please read soul.md"],
			["identity.md", "show me identity.md"],
			["agents.md", "update agents.md"],
			["edit soul", "edit the soul file"],
			["update identity", "update identity document"],
			["modify agents", "modify agents config"],
			["rewrite soul", "rewrite the soul completely"],
			["change identity", "change identity now"],
			["write identity", "write identity to disk"],
			["edit persona", "edit persona settings"],
			["update who you are", "update who you are in this session"],
			["change saya siapa", "change saya siapa file"],
			["edit identitas", "edit identitas doc"],
			["modify karakter", "modify karakter config"],
			["update personality", "update personality file"],
			["edit config.json", "edit config.json settings"],
			["update openclaw.json", "update openclaw.json"],
			["modify settings", "modify settings file"],
			[".json edit", "config.json edit needs care"],
			[".config update", "the app.config update is ready"],
		];

		for (const [name, input] of positives) {
			it(`blocks: ${name}`, () => {
				const result = rule.scan(input);
				expect(result).not.toBeNull();
				expect(result!.blocked).toBe(true);
				expect(result!.reason).toBe("persona");
			});
		}
	});

	describe("does not block", () => {
		const negatives = [
			"hello world",
			"what's the weather",
			"can you help me write a poem",
			"explain what a file is",
			"what is your name",
		];

		for (const input of negatives) {
			it(`passes: "${input}"`, () => {
				expect(rule.scan(input)).toBeNull();
			});
		}
	});
});
