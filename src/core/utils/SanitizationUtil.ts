/**
 * Utility for sanitizing objects by redacting sensitive information.
 */
export class SanitizationUtil {
    private static readonly SENSITIVE_PATTERNS = [
        /key/i,
        /token/i,
        /password/i,
        /secret/i,
        /auth/i,
        /credential/i,
        /cert/i,
        /private/i
    ];

    /**
     * Recursively scrubs sensitive values from an object.
     * Returns a new object with sensitive fields redacted.
     */
    public static scrubObject(obj: any): any {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj !== 'object') return obj;

        if (Array.isArray(obj)) {
            return obj.map(item => this.scrubObject(item));
        }

        const scrubbed: any = {};
        for (const [key, value] of Object.entries(obj)) {
            if (this.isSensitive(key)) {
                scrubbed[key] = '[REDACTED]';
            } else if (typeof value === 'object') {
                scrubbed[key] = this.scrubObject(value);
            } else {
                scrubbed[key] = value;
            }
        }
        return scrubbed;
    }

    /**
     * Checks if a key name is considered sensitive.
     */
    private static isSensitive(key: string): boolean {
        return this.SENSITIVE_PATTERNS.some(pattern => pattern.test(key));
    }

    /**
     * Scrubs a string (e.g. tool result) from potential key matches.
     * Note: This is less precise than object scrubbing.
     */
    public static scrubString(str: string): string {
        if (!str) return str;
        // Simple regex to redact potential API keys (look for patterns like key=XYZ or "key": "XYZ")
        return str.replace(/([kK]ey|[tT]oken|[pP]assword|[sS]ecret)\s*[:=]\s*["']?([^"'\s,]+)["']?/g, '$1: [REDACTED]');
    }

    /**
     * Strips any injected [ENVIRONMENT CONTEXT: ...] or legacy [system context ...] 
     * from a user message string before processing its content for safety checks.
     */
    public static stripContext(content: string): string {
        if (!content) return content;
        return content
            .replace(/\[ENVIRONMENT CONTEXT:[\s\S]*?\]\n\n/gi, '')
            .replace(/\[system context[\s\S]*?\]\n\n/gi, '')
            .trim();
    }
}


