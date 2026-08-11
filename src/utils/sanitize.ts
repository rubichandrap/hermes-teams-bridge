export function sanitizeId(conversationId: string): string {
	return conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
