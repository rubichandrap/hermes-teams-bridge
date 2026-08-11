import { describe, expect, it } from "vitest";
import type { SecurityResult } from "../types";
import { SecurityScanner } from "./index.js";
import type { ISecurityRule } from "./rules/interface.js";

describe("SecurityScanner", () => {
	const noopRule: ISecurityRule = {
		scan: () => null,
	};

	const blockRule: ISecurityRule = {
		scan: (): SecurityResult => ({
			blocked: true,
			reason: "custom",
			warning: "blocked by custom rule",
		}),
	};

	const secondBlockRule: ISecurityRule = {
		scan: (): SecurityResult => ({
			blocked: true,
			reason: "second",
			warning: "second rule should not run",
		}),
	};

	it("returns blocked=false when no rules match", () => {
		const scanner = new SecurityScanner([noopRule]);
		expect(scanner.scan("hello")).toEqual({ blocked: false });
	});

	it("returns the first match (first-match-wins)", () => {
		const scanner = new SecurityScanner([blockRule, secondBlockRule]);
		const result = scanner.scan("anything");
		expect(result!.reason).toBe("custom");
	});

	it("stops at the first matching rule", () => {
		const scanner = new SecurityScanner([blockRule, secondBlockRule]);
		const result = scanner.scan("anything");
		expect(result!.reason).not.toBe("second");
	});

	it("addRule appends a rule that runs last by default", () => {
		const scanner = new SecurityScanner([noopRule]);
		scanner.addRule(blockRule);
		const result = scanner.scan("anything");
		expect(result!.blocked).toBe(true);
		expect(result!.reason).toBe("custom");
	});

	it("uses default rules (3) when none provided", () => {
		const scanner = new SecurityScanner();
		const blockedResult = scanner.scan("please rm -rf /tmp");
		expect(blockedResult!.blocked).toBe(true);
		const passResult = scanner.scan("hello world");
		expect(passResult.blocked).toBe(false);
	});
});
