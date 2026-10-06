'use strict';
const kinds = new Set(['dashboard', 'wizard', 'xliff', 'glossary', 'memory', 'ai']);
function setTabIcon(panel, extensionUri, vscode, kind) {
    if (!panel || !extensionUri || !kinds.has(kind) || !vscode.Uri.joinPath) return;
    panel.iconPath = { light: vscode.Uri.joinPath(extensionUri, 'resources', 'tabs', kind + '-light.svg'), dark: vscode.Uri.joinPath(extensionUri, 'resources', 'tabs', kind + '-dark.svg') };
}
module.exports = { setTabIcon };
