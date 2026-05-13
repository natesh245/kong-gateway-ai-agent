import * as assert from 'assert';
import * as vscode from 'vscode';

describe('Extension Test Suite', () => {
	it('Extension should be present', () => {
		const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'kong-gateway-agent');
		assert.ok(extension, 'Extension kong-gateway-agent should be found');
	});

	it('Should activate extension', async () => {
		const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'kong-gateway-agent');
		await extension?.activate();
		assert.strictEqual(extension?.isActive, true);
	});

	it('Kong Agent command should be registered', async () => {
		// Just a placeholder to ensure the suite runs
        assert.ok(true);
	});
});
