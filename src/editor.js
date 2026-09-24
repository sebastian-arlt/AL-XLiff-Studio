'use strict';

const vscode = require('vscode');
const { parseLng, serializeLng } = require('./lng');

class LanguageMapEditorProvider {
    static viewType = 'bcXliffLanguageMap.lngEditor';

    constructor(context) {
        this.context = context;
    }

    static register(context) {
        const provider = new LanguageMapEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(LanguageMapEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true
        });
    }

    async resolveCustomTextEditor(document, webviewPanel) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
        let applyingFromWebview = false;

        const postDocument = () => {
            const parsed = parseLng(document.getText());
            webviewPanel.webview.postMessage({
                type: 'document',
                entries: parsed.entries,
                errors: parsed.errors,
                language: detectLanguageFromLngName(document.uri.path)
            });
        };

        const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() !== document.uri.toString()) return;
            if (!applyingFromWebview) postDocument();
        });
        webviewPanel.onDidDispose(() => changeSubscription.dispose());

        webviewPanel.webview.onDidReceiveMessage(async message => {
            if (message.type === 'ready') {
                postDocument();
                return;
            }
            if (message.type === 'searchSource') {
                const source = typeof message.source === 'string' ? message.source : '';
                if (!source) return;
                await vscode.commands.executeCommand('workbench.action.findInFiles', createFindInFilesArgs(source));
                return;
            }
            if (message.type !== 'replace') return;

            const entries = Array.isArray(message.entries) ? message.entries : [];
            const validation = validateEntries(entries);
            if (validation) {
                webviewPanel.webview.postMessage({ type: 'error', message: validation });
                postDocument();
                return;
            }

            const language = detectLanguageFromLngName(document.uri.path);
            const newText = serializeLng(entries, language);
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, fullRange, newText);
            applyingFromWebview = true;
            try {
                await vscode.workspace.applyEdit(edit);
            } finally {
                applyingFromWebview = false;
            }
        });
    }

    getHtml(webview) {
        const nonce = String(Date.now());
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>BC Language Map</title>
<style>
body { padding: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
.toolbar { position: sticky; top: 0; z-index: 2; display:flex; gap:8px; align-items:center; padding:10px 12px; background: var(--vscode-editor-background); border-bottom:1px solid var(--vscode-panel-border); }
.toolbar input[type="search"] { flex:1; min-width:180px; }
.toggle-filter { display:flex; gap:5px; align-items:center; color:var(--vscode-descriptionForeground); white-space:nowrap; }
.toggle-filter input { margin:0; }
input, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border:1px solid var(--vscode-input-border); padding:5px 7px; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor:pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
.meta { color: var(--vscode-descriptionForeground); white-space:nowrap; }
.error { margin:8px 12px; padding:8px; border:1px solid var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); display:none; white-space:pre-wrap; }
table { width:100%; border-collapse:collapse; table-layout:fixed; }
th { position:sticky; top:48px; z-index:1; text-align:left; background:var(--vscode-editor-background); border-bottom:1px solid var(--vscode-panel-border); padding:7px 10px; }
td { vertical-align:top; border-bottom:1px solid var(--vscode-panel-border); padding:5px 7px; }
td input { width:100%; box-sizing:border-box; border-color:transparent; background:transparent; }
td input:focus { border-color:var(--vscode-focusBorder); background:var(--vscode-input-background); outline:none; }
.col-source,.col-translation { width:45%; }.col-actions { width:10%; text-align:center; }
.action-buttons { display:flex; gap:4px; justify-content:center; }
.action-buttons button { min-width:30px; padding:4px 6px; }
.hidden { display:none; }
</style>
</head>
<body>
<div class="toolbar">
  <input id="search" type="search" placeholder="Filter source or translation...">
  <label class="toggle-filter"><input id="sameOnly" type="checkbox"> Source = Translation</label>
  <button id="add">Add</button>
  <button id="sort">Sort</button>
  <span class="meta" id="meta"></span>
</div>
<div class="error" id="error"></div>
<table>
<thead><tr><th class="col-source">English source</th><th class="col-translation">Translation</th><th class="col-actions"></th></tr></thead>
<tbody id="rows"></tbody>
</table>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let entries = [];
let language = '';
const rows = document.getElementById('rows');
const errorBox = document.getElementById('error');
const meta = document.getElementById('meta');
const search = document.getElementById('search');
const sameOnly = document.getElementById('sameOnly');

function esc(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function render() {
  const filter = search.value.toLocaleLowerCase();
  let visibleCount = 0;
  rows.innerHTML = entries.map((entry, index) => {
    const hay = (entry.source + ' ' + entry.translation).toLocaleLowerCase();
    const matchesText = !filter || hay.includes(filter);
    const matchesSame = !sameOnly.checked || entry.source === entry.translation;
    const visible = matchesText && matchesSame;
    if (visible) visibleCount++;
    const hidden = visible ? '' : ' hidden';
    return '<tr class="' + hidden + '" data-index="' + index + '">' +
      '<td><input class="source" value="' + esc(entry.source) + '"></td>' +
      '<td><input class="translation" value="' + esc(entry.translation) + '"></td>' +
      '<td><div class="action-buttons">' +
        '<button class="search-source" title="Search English source in project" aria-label="Search English source in project">&#128269;</button>' +
        '<button class="delete" title="Delete" aria-label="Delete">×</button>' +
      '</div></td></tr>';
  }).join('');
  meta.textContent = (language ? language + ' · ' : '') + visibleCount + ' / ' + entries.length + ' entries';
}
function commit() { vscode.postMessage({ type:'replace', entries }); }
rows.addEventListener('change', event => {
  const tr = event.target.closest('tr'); if (!tr) return;
  const index = Number(tr.dataset.index);
  if (event.target.classList.contains('source')) entries[index].source = event.target.value;
  if (event.target.classList.contains('translation')) entries[index].translation = event.target.value;
  commit();
});
rows.addEventListener('click', event => {
  const tr = event.target.closest('tr');
  if (!tr) return;
  const index = Number(tr.dataset.index);
  if (event.target.classList.contains('search-source')) {
    vscode.postMessage({ type:'searchSource', source: entries[index].source });
    return;
  }
  if (event.target.classList.contains('delete')) {
    entries.splice(index, 1); render(); commit();
  }
});
search.addEventListener('input', render);
sameOnly.addEventListener('change', render);
document.getElementById('sort').addEventListener('click', () => { entries.sort((a,b) => a.source.localeCompare(b.source)); render(); commit(); });
document.getElementById('add').addEventListener('click', () => {
  const source = window.prompt('English source text');
  if (!source) return;
  if (entries.some(e => e.source === source)) { showError('This source text already exists.'); return; }
  entries.push({ source, translation:'' }); render(); commit();
});
function showError(message) { errorBox.textContent = message; errorBox.style.display = message ? 'block' : 'none'; }
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'document') {
    entries = message.entries || []; language = message.language || '';
    showError((message.errors || []).join(String.fromCharCode(10))); render();
  } else if (message.type === 'error') { showError(message.message || 'Invalid language map.'); }
});
vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;
    }
}

function createFindInFilesArgs(source) {
    return {
        query: source,
        triggerSearch: true,
        isRegex: false,
        matchWholeWord: false
    };
}

function validateEntries(entries) {
    const seen = new Set();
    for (let i = 0; i < entries.length; i++) {
        const source = typeof entries[i].source === 'string' ? entries[i].source : '';
        const translation = typeof entries[i].translation === 'string' ? entries[i].translation : '';
        if (!source) return `Row ${i + 1}: source must not be empty.`;
        if (seen.has(source)) return `Row ${i + 1}: duplicate source text: ${source}`;
        if (typeof translation !== 'string') return `Row ${i + 1}: translation must be text.`;
        seen.add(source);
    }
    return undefined;
}

function detectLanguageFromLngName(path) {
    const match = path.match(/\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})+)\.lng$/i);
    return match ? match[1] : '';
}

module.exports = { LanguageMapEditorProvider, createFindInFilesArgs, validateEntries, detectLanguageFromLngName };
