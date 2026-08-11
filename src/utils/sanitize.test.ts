import { describe, expect, it } from "vitest";
import { sanitizeId } from "./sanitize";

describe("sanitizeId", () => {
	it("keeps alphanumeric characters unchanged", () => {
		expect(sanitizeId("abc123XYZ")).toBe("abc123XYZ");
	});

	it("replaces non-alphanumeric characters with underscore", () => {
		expect(sanitizeId("abc.def")).toBe("abc_def");
		expect(sanitizeId("19:abc@thread")).toBe("19_abc_thread");
	});

	it("preserves hyphens and underscores", () => {
		expect(sanitizeId("a-b_c-d")).toBe("a-b_c-d");
	});

	it("returns empty string for empty input", () => {
		expect(sanitizeId("")).toBe("");
	});

	it("handles Teams-style conversation IDs", () => {
		expect(sanitizeId("19:abcDEF123@thread.v2")).toBe("19_abcDEF123_thread_v2");
	});
});
