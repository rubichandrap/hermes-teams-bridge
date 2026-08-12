import { describe, expect, it } from "vitest";
import { FileWriteRule } from "./file-write.rule";

const rule = new FileWriteRule();

describe("FileWriteRule", () => {
	describe("blocks", () => {
		const positives: Array<[string, string]> = [
			["write a file", "please write a file called notes.txt"],
			["edit a file", "edit the file config.json"],
			["update a file", "update the file README.md"],
			["create a folder", "create a folder named test"],
			["create a directory", "create a directory called src"],
			["make a file", "make a new file index.ts"],
			["touch a file", "touch a file called out.log"],
			["append to a file", "append to the file log.txt"],
			["overwrite the file", "overwrite the file config.json"],
			["modify the path", "modify the path /home/user/.bashrc"],
			["file .ts", "update the file src/index.ts"],
			["file .py", "create file .py"],
			["apply_patch", "apply_patch this file"],
			["edit_tool", "use the edit_tool"],
			["write_file", "call write_file with content"],
			["create_file", "invoke create_file to add this"],
			["update_file", "use update_file to change this"],
			["modify_file", "call modify_file on the config"],
			["home path with .json", "change ~/.hermes/settings.json"],
			["home path with config", "edit /home/user/app.config file"],
			["memory.md", "update memory.md please"],
			["edit memory", "edit memory to add this"],
			["update memory", "update memory with new info"],
			["change memory", "change memory now"],
			["rewrite memory", "rewrite memory entirely"],
			["write memory", "write memory to disk"],
		];

		for (const [name, input] of positives) {
			it(`blocks: ${name}`, () => {
				const result = rule.scan(input);
				expect(result).not.toBeNull();
				expect(result!.blocked).toBe(true);
				expect(result!.reason).toBe("filewrite");
			});
		}
	});

	describe("does not block", () => {
		const negatives = [
			"hello world",
			"what is the weather today",
			"can you read my notes",
			"please show me the contents of the file",
			"explain how git works",
		];

		for (const input of negatives) {
			it(`passes: "${input}"`, () => {
				expect(rule.scan(input)).toBeNull();
			});
		}
	});
});
