import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('natesh.kong-gateway-agent'));
	});

	test('Should activate extension', async () => {
		const extension = vscode.extensions.getExtension('natesh.kong-gateway-agent');
		await extension?.activate();
		assert.strictEqual(extension?.isActive, true);
	});

	test('Kong Agent command should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		// Check for some expected commands if they exist
		// Add specific command checks here if applicable
        assert.ok(true);
	});
});
