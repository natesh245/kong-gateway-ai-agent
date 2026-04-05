/**
 * Utility to access the VS Code Webview API.
 */

declare const acquireVsCodeApi: <T = any>() => {
    postMessage: (message: any) => void;
    getState: () => T;
    setState: (state: T) => void;
};

// The VS Code API can only be acquired once.
let vscode: any;

export function getVsCodeApi() {
    if (!vscode) {
        if (typeof acquireVsCodeApi !== 'undefined') {
            vscode = acquireVsCodeApi();
        } else {
            // Fallback for development/testing outside VS Code
            vscode = {
                postMessage: (msg: any) => console.log('VS Code postMessage:', msg),
                getState: () => ({}),
                setState: (s: any) => console.log('VS Code setState:', s)
            };
        }
    }
    return vscode;
}
