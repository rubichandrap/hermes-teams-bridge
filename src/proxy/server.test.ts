import { describe, expect, it } from "vitest";
import { checkProxyAuth } from "./server";

describe("checkProxyAuth", () => {
	const TOKEN = "s3cret-token";

	it("accepts Bearer-prefixed tokens", () => {
		expect(checkProxyAuth(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
	});

	it("accepts bare tokens", () => {
		expect(checkProxyAuth(TOKEN, TOKEN)).toBe(true);
	});

	it("accepts Bearer with surrounding whitespace", () => {
		expect(checkProxyAuth(`  Bearer ${TOKEN}  `, TOKEN)).toBe(true);
	});

	it("rejects missing headers", () => {
		expect(checkProxyAuth(undefined, TOKEN)).toBe(false);
	});

	it("rejects wrong tokens", () => {
		expect(checkProxyAuth(`Bearer wrong`, TOKEN)).toBe(false);
		expect(checkProxyAuth(`Bearer ${TOKEN} extra`, TOKEN)).toBe(false);
	});

	it("rejects empty token config", () => {
		expect(checkProxyAuth(`Bearer ${TOKEN}`, "")).toBe(false);
	});
});
