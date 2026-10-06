'use strict';
const vscode = require('vscode');

// Codicons from Microsoft VS Code; attribution and license accompany the font.
function iconStyles(webview, extensionUri) {
    if (!extensionUri || !webview || !webview.asWebviewUri) return '';
    const font = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'codicon.ttf'));
    return `@font-face{font-family:alxliff-codicon;src:url('${font}') format('truetype');font-display:block}.codicon{font-family:alxliff-codicon!important;font-style:normal;font-weight:normal;font-size:16px;line-height:1;vertical-align:middle;display:inline-block}`;
}

module.exports = { iconStyles };
