'use strict';

const vscode = require('vscode');
const path = require('path');
const { GLOSSARY_EDITOR_VIEW_TYPE, BRAND_NAME, CONFIG_SECTION } = require('./identity');
const { DEFAULT_GLOSSARY_FILENAME, LEGACY_GLOSSARY_FILENAME, parseGlossary, serializeGlossary, normalizeEntries } = require('./glossary');
const { getDefaultGlossaryUri, ensureStudioStructure, workspaceFileExists, STUDIO_DIRECTORY } = require('./studioPaths');

class GlossaryEditorProvider {
    static viewType = GLOSSARY_EDITOR_VIEW_TYPE;

    static register(context) {
        const provider = new GlossaryEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(GlossaryEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true
        });
    }

    constructor(context) {
        this.context = context;
    }

    async resolveCustomTextEditor(document, webviewPanel) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
        let applyingFromWebview = false;

        const postDocument = () => {
            const parsed = parseGlossary(document.getText());
            webviewPanel.webview.postMessage({ type: 'document', entries: parsed.entries, errors: parsed.errors });
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
                if (source) await vscode.commands.executeCommand('workbench.action.findInFiles', {
                    query: source,
                    triggerSearch: true,
                    isRegex: false,
                    matchWholeWord: false
                });
                return;
            }
            if (message.type !== 'replace') return;

            const rawEntries = Array.isArray(message.entries) ? message.entries : [];
            const validation = validateGlossaryEntries(rawEntries);
            const entries = normalizeEntries(rawEntries);
            if (validation) {
                webviewPanel.webview.postMessage({ type: 'error', message: validation });
                postDocument();
                return;
            }

            const newText = serializeGlossary(entries);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), newText);
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
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>AL Xliff Studio — Terminology Glossary</title>
<style>
*{box-sizing:border-box}body{padding:0;margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}
.toolbar{position:sticky;top:0;z-index:3;display:flex;gap:8px;align-items:center;padding:10px 12px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
.toolbar input[type=search]{flex:1;min-width:200px}.toolbar select{min-width:120px}.meta{color:var(--vscode-descriptionForeground);white-space:nowrap}
input,select,button{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:5px 7px}
button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
.error{display:none;margin:8px 12px;padding:8px;border:1px solid var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground);white-space:pre-wrap}
table{width:100%;border-collapse:collapse;table-layout:fixed}th{position:sticky;top:49px;z-index:2;text-align:left;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);padding:7px}td{vertical-align:top;border-bottom:1px solid var(--vscode-panel-border);padding:5px}
td input,td select{width:100%;background:transparent;border-color:transparent}td input:focus,td select:focus{background:var(--vscode-input-background);border-color:var(--vscode-focusBorder);outline:none}
.c-source{width:18%}.c-language{width:9%}.c-translation{width:18%}.c-match{width:8%}.c-case{width:6%;text-align:center}.c-quality{width:16%}.c-note{width:18%}.c-actions{width:7%;text-align:center}.actions{display:flex;gap:4px;justify-content:center}.actions button{min-width:30px;padding:4px}.hidden{display:none}.casebox{display:flex;justify-content:center;padding-top:6px}
</style></head><body>
<div class="toolbar"><input id="search" type="search" placeholder="Filter terminology..."><select id="language"><option value="">All languages</option></select><button id="add">+ Add term</button><button id="sort">↕ Sort</button><span class="meta" id="meta"></span></div>
<div class="error" id="error"></div>
<table><thead><tr><th class="c-source">Source term</th><th class="c-language">Language</th><th class="c-translation">Required translation</th><th class="c-match">Match</th><th class="c-case">Case</th><th class="c-quality">Quality exceptions</th><th class="c-note">Note</th><th class="c-actions"></th></tr></thead><tbody id="rows"></tbody></table>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let entries=[];const rows=document.getElementById('rows'),search=document.getElementById('search'),language=document.getElementById('language'),meta=document.getElementById('meta'),errorBox=document.getElementById('error');
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function commit(){vscode.postMessage({type:'replace',entries});}
function languages(){return [...new Set(entries.map(e=>e.targetLanguage).filter(Boolean))].sort((a,b)=>a.localeCompare(b));}
function render(){const q=search.value.toLocaleLowerCase(),lang=language.value;const old=lang;language.innerHTML='<option value="">All languages</option>'+languages().map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');if(languages().includes(old))language.value=old;let visible=0;rows.innerHTML=entries.map((e,i)=>{const quality=(e.qualityIgnore||[]).join(', ');const hay=(e.source+' '+e.targetLanguage+' '+e.translation+' '+quality+' '+(e.note||'')).toLocaleLowerCase();const show=(!q||hay.includes(q))&&(!lang||e.targetLanguage===lang);if(show)visible++;return '<tr data-index="'+i+'" class="'+(show?'':'hidden')+'"><td><input data-field="source" value="'+esc(e.source)+'"></td><td><input data-field="targetLanguage" value="'+esc(e.targetLanguage)+'"></td><td><input data-field="translation" value="'+esc(e.translation)+'"></td><td><select data-field="match"><option value="word"'+(e.match==='word'?' selected':'')+'>word</option><option value="exact"'+(e.match==='exact'?' selected':'')+'>exact</option><option value="contains"'+(e.match==='contains'?' selected':'')+'>contains</option></select></td><td><div class="casebox"><input data-field="caseSensitive" type="checkbox"'+(e.caseSensitive?' checked':'')+'></div></td><td><input data-field="qualityIgnore" title="Comma-separated Quality Check codes to suppress when this glossary rule is satisfied, e.g. punctuation" placeholder="punctuation" value="'+esc(quality)+'"></td><td><input data-field="note" value="'+esc(e.note||'')+'"></td><td><div class="actions"><button data-action="search" title="Search source term in project">⌕</button><button data-action="delete" title="Delete term">×</button></div></td></tr>';}).join('');meta.textContent=visible+' / '+entries.length+' terms';}
rows.addEventListener('change',e=>{const tr=e.target.closest('tr');if(!tr)return;const i=Number(tr.dataset.index),field=e.target.dataset.field;if(!field)return;if(field==='caseSensitive')entries[i][field]=e.target.checked;else if(field==='qualityIgnore')entries[i][field]=String(e.target.value||'').split(',').map(v=>v.trim()).filter(Boolean);else entries[i][field]=e.target.value;commit();render();});
rows.addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;const tr=b.closest('tr'),i=Number(tr.dataset.index);if(b.dataset.action==='delete'){entries.splice(i,1);commit();render();}else if(b.dataset.action==='search'){vscode.postMessage({type:'searchSource',source:entries[i].source});}});
search.addEventListener('input',render);language.addEventListener('change',render);document.getElementById('sort').addEventListener('click',()=>{entries.sort((a,b)=>a.targetLanguage.localeCompare(b.targetLanguage)||a.source.localeCompare(b.source));commit();render();});document.getElementById('add').addEventListener('click',()=>{const source=window.prompt('Source term or phrase');if(!source)return;const targetLanguage=window.prompt('Target language','de-DE');if(!targetLanguage)return;const translation=window.prompt('Required translation');if(!translation)return;entries.push({source:source,targetLanguage:targetLanguage,translation:translation,match:'word',caseSensitive:false,qualityIgnore:[],note:''});commit();render();});
function showError(m){errorBox.textContent=m||'';errorBox.style.display=m?'block':'none'}window.addEventListener('message',e=>{const m=e.data;if(m.type==='document'){entries=m.entries||[];showError((m.errors||[]).join(String.fromCharCode(10)));render();}else if(m.type==='error')showError(m.message||'Invalid glossary.');});vscode.postMessage({type:'ready'});
</script></body></html>`;
    }
}

function validateGlossaryEntries(entries) {
    const seen = new Set();
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry.source) return `Row ${index + 1}: source term must not be empty.`;
        if (!entry.targetLanguage) return `Row ${index + 1}: target language must not be empty.`;
        if (!entry.translation) return `Row ${index + 1}: translation must not be empty.`;
        const key = `${entry.targetLanguage.toLocaleLowerCase()}\u0000${entry.caseSensitive ? entry.source : entry.source.toLocaleLowerCase()}`;
        if (seen.has(key)) return `Row ${index + 1}: duplicate term for ${entry.targetLanguage}: ${entry.source}`;
        seen.add(key);
    }
    return undefined;
}

async function getProjectGlossaryUri(resourceUri, chooseWhenAmbiguous = false) {
    const resolved = await resolveProjectGlossary(resourceUri, chooseWhenAmbiguous);
    return resolved.uri;
}

async function resolveProjectGlossary(resourceUri, chooseWhenAmbiguous = false) {
    const folder = await getProjectWorkspaceFolder(resourceUri, chooseWhenAmbiguous);
    if (!folder) return { uri: undefined, folder: undefined, candidates: [], ambiguous: false };

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder.uri);
    const configuredPath = String(config.get('glossary.path', '') || '').trim();
    const configuredUri = configuredPath ? glossaryUriFromSetting(folder, configuredPath) : undefined;

    if (configuredUri && await workspaceFileExists(configuredUri)) {
        return { uri: configuredUri, folder, candidates: [configuredUri], ambiguous: false, configured: true };
    }

    const defaultUri = await getDefaultGlossaryUri(resourceUri || folder.uri);
    if (defaultUri && await workspaceFileExists(defaultUri)) {
        return { uri: defaultUri, folder, candidates: [defaultUri], ambiguous: false, studioDefault: true };
    }

    // Backward compatibility: older versions placed .al-xliff-glossary.json anywhere
    // in the workspace. With no explicit path configured, migrate a single legacy
    // glossary into the AL project's .alxliffstudio directory.
    const legacyCandidates = await findLegacyProjectGlossaries(folder);
    if (!configuredPath && legacyCandidates.length === 1 && defaultUri) {
        await ensureStudioStructure(resourceUri || folder.uri);
        const content = await vscode.workspace.fs.readFile(legacyCandidates[0]);
        await vscode.workspace.fs.writeFile(defaultUri, content);
        try {
            if (typeof vscode.workspace.fs.delete === 'function') await vscode.workspace.fs.delete(legacyCandidates[0], { useTrash: false });
        } catch (_) {
            // The migrated file is already complete. Keep a legacy duplicate if cleanup fails.
        }
        return { uri: defaultUri, folder, candidates: [defaultUri], ambiguous: false, migrated: true };
    }

    if (!configuredPath && legacyCandidates.length > 1) {
        if (!chooseWhenAmbiguous) return { uri: undefined, folder, candidates: legacyCandidates, ambiguous: true };
        const pick = await vscode.window.showQuickPick(
            legacyCandidates.map(uri => ({
                label: relativeGlossaryPath(folder, uri),
                description: uri.fsPath || uri.path,
                uri
            })),
            { placeHolder: 'Select the terminology glossary to migrate into .alxliffstudio' }
        );
        if (!pick) return { uri: undefined, folder, candidates: legacyCandidates, ambiguous: true };
        if (defaultUri) {
            await ensureStudioStructure(resourceUri || folder.uri);
            const content = await vscode.workspace.fs.readFile(pick.uri);
            await vscode.workspace.fs.writeFile(defaultUri, content);
            try {
                if (typeof vscode.workspace.fs.delete === 'function') await vscode.workspace.fs.delete(pick.uri, { useTrash: false });
            } catch (_) { /* keep legacy duplicate */ }
            return { uri: defaultUri, folder, candidates: [defaultUri], ambiguous: false, migrated: true };
        }
    }

    // Respect an explicit custom path, even when the file does not exist yet.
    // Otherwise the default is <AL project>/.alxliffstudio/glossary.json.
    const uri = configuredUri || defaultUri;
    return { uri, folder, candidates: [], ambiguous: false, configured: Boolean(configuredUri), studioDefault: !configuredUri };
}

async function getProjectWorkspaceFolder(resourceUri, chooseWhenAmbiguous) {
    let folder = resourceUri ? vscode.workspace.getWorkspaceFolder(resourceUri) : undefined;
    if (!folder && vscode.window.activeTextEditor) folder = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folder && folders.length === 1) folder = folders[0];
    if (!folder && chooseWhenAmbiguous && folders.length > 1) {
        const pick = await vscode.window.showQuickPick(
            folders.map(item => ({ label: item.name, description: item.uri.fsPath, folder: item })),
            { placeHolder: 'Select the project for the terminology glossary' }
        );
        folder = pick && pick.folder;
    }
    return folder;
}

function glossaryUriFromSetting(folder, configuredPath) {
    const value = String(configuredPath || '').trim();
    if (!value) return undefined;
    if (folder.uri.scheme === 'file' && path.isAbsolute(value)) return vscode.Uri.file(value);
    const segments = value.replace(/\\/g, '/').split('/').filter(segment => segment && segment !== '.');
    return vscode.Uri.joinPath(folder.uri, ...segments);
}

async function findProjectGlossaries(folder) {
    if (!folder) return [];
    const found = [];
    const studioPattern = new vscode.RelativePattern(folder, `**/${STUDIO_DIRECTORY}/${DEFAULT_GLOSSARY_FILENAME}`);
    const exclude = '**/{.git,node_modules,.alpackages}/**';
    for (const uri of await vscode.workspace.findFiles(studioPattern, exclude)) found.push(uri);
    for (const uri of await findLegacyProjectGlossaries(folder)) {
        if (!found.some(existing => existing.toString() === uri.toString())) found.push(uri);
    }
    return found.sort((a, b) => relativeGlossaryPath(folder, a).localeCompare(relativeGlossaryPath(folder, b)));
}

async function findLegacyProjectGlossaries(folder) {
    if (!folder || !vscode.workspace.findFiles || !vscode.RelativePattern) return [];
    const pattern = new vscode.RelativePattern(folder, `**/${LEGACY_GLOSSARY_FILENAME}`);
    const exclude = '**/{.git,node_modules,.alpackages}/**';
    const found = await vscode.workspace.findFiles(pattern, exclude);
    return [...found].sort((a, b) => relativeGlossaryPath(folder, a).localeCompare(relativeGlossaryPath(folder, b)));
}

function relativeGlossaryPath(folder, uri) {
    if (folder.uri.scheme === 'file' && uri.scheme === 'file') {
        return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    }
    const base = String(folder.uri.path || '').replace(/\/$/, '');
    const full = String(uri.path || '');
    return full.startsWith(base + '/') ? full.slice(base.length + 1) : full;
}

async function readProjectGlossary(resourceUri) {
    const resolved = await resolveProjectGlossary(resourceUri, false);
    if (resolved.ambiguous) {
        const locations = resolved.candidates.map(uri => relativeGlossaryPath(resolved.folder, uri)).join(', ');
        return {
            uri: undefined,
            entries: [],
            errors: [`Multiple terminology glossaries found (${locations}). Open “Terminology Glossary” once to select one, or set ${CONFIG_SECTION}.glossary.path.`]
        };
    }
    const uri = resolved.uri;
    if (!uri) return { uri: undefined, entries: [], errors: [] };
    try {
        const text = await readWorkspaceText(uri);
        const parsed = parseGlossary(text);
        return { uri, entries: parsed.entries, errors: parsed.errors };
    } catch (err) {
        if (err && (err.code === 'FileNotFound' || err.code === 'ENOENT')) return { uri, entries: [], errors: [] };
        return { uri, entries: [], errors: [String(err && err.message || err)] };
    }
}

async function openProjectGlossary(resourceUri) {
    const resolved = await resolveProjectGlossary(resourceUri, true);
    const uri = resolved.uri;
    if (!uri) {
        if (!resolved.folder) vscode.window.showInformationMessage(`${BRAND_NAME}: open a workspace folder first.`);
        return;
    }
    try {
        await vscode.workspace.fs.stat(uri);
    } catch (_) {
        await ensureStudioStructure(resourceUri || resolved.folder && resolved.folder.uri);
        const parent = vscode.Uri.joinPath(uri, '..');
        if (vscode.workspace.fs.createDirectory) await vscode.workspace.fs.createDirectory(parent);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(serializeGlossary([]), 'utf8'));
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, GlossaryEditorProvider.viewType);
}

async function addGlossaryEntry(resourceUri, entry) {
    const resolved = await resolveProjectGlossary(resourceUri, false);
    if (resolved.ambiguous) throw new Error(`Multiple terminology glossaries found. Open “Terminology Glossary” once to select one, or set ${CONFIG_SECTION}.glossary.path.`);
    const uri = resolved.uri;
    if (!uri) throw new Error('No workspace folder is available for the terminology glossary.');
    let parsed = { entries: [] };
    try {
        parsed = parseGlossary(await readWorkspaceText(uri));
    } catch (err) {
        if (!(err && (err.code === 'FileNotFound' || err.code === 'ENOENT'))) throw err;
        const parent = vscode.Uri.joinPath(uri, '..');
        if (vscode.workspace.fs.createDirectory) await vscode.workspace.fs.createDirectory(parent);
    }
    const normalized = normalizeEntries([entry])[0];
    if (!normalized) throw new Error('Source term, target language and translation are required.');
    const index = parsed.entries.findIndex(item => item.targetLanguage.toLocaleLowerCase() === normalized.targetLanguage.toLocaleLowerCase() && (item.caseSensitive ? item.source === normalized.source : item.source.toLocaleLowerCase() === normalized.source.toLocaleLowerCase()));
    if (index >= 0) parsed.entries[index] = normalized; else parsed.entries.push(normalized);
    await writeWorkspaceText(uri, serializeGlossary(parsed.entries));
    return uri;
}

async function readWorkspaceText(uri) {
    const openDocument = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === uri.toString());
    if (openDocument) return openDocument.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function writeWorkspaceText(uri, text) {
    const openDocument = (vscode.workspace.textDocuments || []).find(document => document.uri.toString() === uri.toString());
    if (!openDocument) {
        const parent = vscode.Uri.joinPath(uri, '..');
        if (vscode.workspace.fs.createDirectory) await vscode.workspace.fs.createDirectory(parent);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        return;
    }
    if (openDocument.getText() === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
}

module.exports = { GlossaryEditorProvider, validateGlossaryEntries, getProjectGlossaryUri, resolveProjectGlossary, findProjectGlossaries, findLegacyProjectGlossaries, glossaryUriFromSetting, relativeGlossaryPath, readProjectGlossary, openProjectGlossary, addGlossaryEntry };
