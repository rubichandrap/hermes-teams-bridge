import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logger from "./logger.js";
import { LogLevel, setLogLevel } from "./logger.js";

describe("logger", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		setLogLevel(LogLevel.INFO);
	});

	describe("level filtering", () => {
		it("emits messages at or above the configured level", () => {
			setLogLevel(LogLevel.WARN);
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			logger.error("e");
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(logSpy.mock.calls[0]![0]).toContain("WARN");
			expect(errorSpy.mock.calls[0]![0]).toContain("ERROR");
		});

		it("emits all levels when set to DEBUG", () => {
			setLogLevel(LogLevel.DEBUG);
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			logger.error("e");
			logger.fatal("f");
			expect(logSpy).toHaveBeenCalledTimes(3);
			expect(errorSpy).toHaveBeenCalledTimes(2);
		});

		it("emits nothing when set to FATAL+1 (above max)", () => {
			setLogLevel(99 as LogLevel);
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			logger.error("e");
			logger.fatal("f");
			expect(logSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		});
	});

	describe("output routing", () => {
		beforeEach(() => {
			setLogLevel(LogLevel.DEBUG);
		});

		it("routes DEBUG, INFO, WARN to stdout", () => {
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			expect(logSpy).toHaveBeenCalledTimes(3);
			expect(errorSpy).not.toHaveBeenCalled();
		});

		it("routes ERROR and FATAL to stderr", () => {
			logger.error("e");
			logger.fatal("f");
			expect(logSpy).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe("output format", () => {
		beforeEach(() => {
			setLogLevel(LogLevel.INFO);
		});

		it("includes ISO timestamp and level label in prefix", () => {
			logger.info("hello");
			const line = logSpy.mock.calls[0]![0] as string;
			expect(line).toMatch(
				/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO: hello$/,
			);
		});

		it("uses ERROR label for error-level messages", () => {
			logger.error("boom");
			const line = errorSpy.mock.calls[0]![0] as string;
			expect(line).toContain("ERROR: boom");
		});

		it("uses FATAL label for fatal-level messages", () => {
			logger.fatal("kaput");
			const line = errorSpy.mock.calls[0]![0] as string;
			expect(line).toContain("FATAL: kaput");
		});
	});

	describe("setLogLevel", () => {
		it("changes the active level threshold", () => {
			setLogLevel(LogLevel.ERROR);
			logger.info("hidden");
			logger.error("shown");
			expect(logSpy).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledTimes(1);
		});
	});
});
