/**
 * Structured logging utility with level filtering
 */

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	FATAL = 4,
}

const LABEL: Record<LogLevel, string> = {
	[LogLevel.DEBUG]: "DEBUG",
	[LogLevel.INFO]: "INFO",
	[LogLevel.WARN]: "WARN",
	[LogLevel.ERROR]: "ERROR",
	[LogLevel.FATAL]: "FATAL",
};

function getConfiguredLevel(): LogLevel {
	const raw = process.env.LOG_LEVEL?.toUpperCase();
	for (const [label, level] of Object.entries(LABEL)) {
		if (label === raw) return Number(level) as LogLevel;
	}
	return LogLevel.INFO;
}

let currentLevel = getConfiguredLevel();

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

export function timestamp(): string {
	return new Date().toISOString();
}

export function log(level: LogLevel, message: string): void {
	if (level < currentLevel) return;

	const line = `[${timestamp()}] ${LABEL[level]}: ${message}`;

	if (level >= LogLevel.ERROR) {
		console.error(line);
	} else {
		console.log(line);
	}
}

export const debug = (msg: string): void => log(LogLevel.DEBUG, msg);
export const info = (msg: string): void => log(LogLevel.INFO, msg);
export const warn = (msg: string): void => log(LogLevel.WARN, msg);
export const error = (msg: string): void => log(LogLevel.ERROR, msg);
export const fatal = (msg: string): void => log(LogLevel.FATAL, msg);
