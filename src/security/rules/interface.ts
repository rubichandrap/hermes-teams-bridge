import type { SecurityResult } from "../../types";

/**
 * Security Rule Interface (DIP)
 * All security rules must implement this interface
 */
export interface ISecurityRule {
	scan(text: string): SecurityResult | null;
}
