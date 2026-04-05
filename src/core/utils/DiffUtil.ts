import * as diff from 'diff';

export class DiffUtil {
    /**
     * Generates a unified diff between two strings.
     * @param filename The name of the file being diffed.
     * @param oldStr The original content.
     * @param newStr The new content.
     */
    public static generateUnifiedDiff(filename: string, oldStr: string, newStr: string): string {
        return diff.createPatch(filename, oldStr, newStr, 'Original', 'Modified');
    }

    /**
     * Formats a raw unified diff for the webview.
     * This adds simple HTML-like markers or just returns the string for the webview to handle.
     */
    public static formatForChat(diffStr: string | undefined): string {
        if (!diffStr) return "No changes detected.";
        
        const lines = diffStr.split('\n');
        // diffStr structure:
        // Index: filename
        // =======================
        // --- filename O
        // +++ filename M
        if (lines.length <= 4) return "No changes detected.";
        
        const diffBody = lines.slice(4).join('\n').trim();
        return diffBody || "No changes detected.";
    }
}
