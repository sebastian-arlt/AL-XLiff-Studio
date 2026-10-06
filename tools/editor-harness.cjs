'use strict';

// Integration adapter for the real provider. Files, XML code, sessions and worker
// threads are real; VS Code's document/events/webview transport are represented
// here. This deliberately does not claim to measure Chromium paints or VS Code UI.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { fileURLToPath, pathToFileURL } = require('node:url');

function createEvent() {
    const listeners = new Set();
    const event = callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
    event.fire = value => { for (const listener of listeners) listener(value); };
    return event;
}

async function createEditorHarness({ root, text, configuration = {} }) {
    const makeUri = value => ({ scheme: 'file', fsPath: path.resolve(value), path: path.resolve(value).replaceAll('\\', '/'), toString() { return pathToFileURL(this.fsPath).href; } });
    await fs.promises.mkdir(path.join(root, 'Translations'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'app.json'), '{}');
    const uri = makeUri(path.join(root, 'Translations/Stress.de-DE.xlf'));
    await fs.promises.writeFile(uri.fsPath, text);
    const onChange = createEvent(), onSave = createEvent(), onClose = createEvent();
    const folder = { uri: makeUri(root), name: 'Stress' };
    const diagnostics = new Map(), commands = [], popups = [], statuses = [];
    const config = { get(key, fallback) { return Object.hasOwn(configuration, key) ? configuration[key] : fallback; } };
    let value = text, lines;
    const document = {
        uri, version: 1, isDirty: false,
        getText() { return value; },
        positionAt(offset) {
            if (!lines) {
                lines = [0];
                for (let next = value.indexOf('\n'); next >= 0; next = value.indexOf('\n', next + 1)) lines.push(next + 1);
            }
            let low = 0, high = lines.length - 1;
            while (low <= high) { const mid = (low + high) >>> 1; if (lines[mid] <= offset) low = mid + 1; else high = mid - 1; }
            return { line: high, character: offset - lines[high], offset };
        },
        async save() { await fs.promises.writeFile(uri.fsPath, value); this.isDirty = false; onSave.fire(this); return true; }
    };
    const diagnosticCollection = { set: (resource, findings) => diagnostics.set(resource.toString(), findings), delete: resource => diagnostics.delete(resource.toString()), clear: () => diagnostics.clear(), dispose() {} };
    class Position { constructor(line, character) { Object.assign(this, { line, character }); } }
    class Range { constructor(start, end) { Object.assign(this, { start, end }); } }
    class WorkspaceEdit { edits = []; replace(resource, range, replacement) { this.edits.push({ resource, range, replacement }); } }
    const vscode = {
        Uri: { file: makeUri, parse: url => makeUri(fileURLToPath(url)), joinPath: (base, ...parts) => makeUri(path.join(base.fsPath, ...parts)) },
        Position, Range, Selection: Range, WorkspaceEdit,
        Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
        ProgressLocation: { Window: 10, Notification: 15 },
        TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
        RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
        workspace: {
            textDocuments: [document], workspaceFolders: [folder], getWorkspaceFolder: () => folder, getConfiguration: () => config,
            onDidChangeTextDocument: onChange, onDidSaveTextDocument: onSave, onDidCloseTextDocument: onClose,
            async openTextDocument(resource) { if (resource.toString() === uri.toString()) return document; throw new Error('Unexpected openTextDocument'); },
            async findFiles() { return []; },
            async applyEdit(edit) {
                for (const item of edit.edits) {
                    if (item.resource.toString() !== uri.toString()) throw new Error('Unexpected document edit');
                    value = value.slice(0, item.range.start.offset) + item.replacement + value.slice(item.range.end.offset);
                }
                lines = undefined;
                document.version++;
                document.isDirty = true;
                onChange.fire({ document, contentChanges: edit.edits });
                return true;
            },
            fs: {
                stat: resource => fs.promises.stat(resource.fsPath),
                readFile: resource => fs.promises.readFile(resource.fsPath),
                writeFile: async (resource, bytes) => { await fs.promises.mkdir(path.dirname(resource.fsPath), { recursive: true }); await fs.promises.writeFile(resource.fsPath, bytes); },
                createDirectory: resource => fs.promises.mkdir(resource.fsPath, { recursive: true })
            }
        },
        window: {
            activeTextEditor: { document },
            setStatusBarMessage: message => { statuses.push(message); },
            showWarningMessage: message => { popups.push(message); },
            showInformationMessage: message => { popups.push(message); },
            showErrorMessage: message => { popups.push(message); },
            withProgress: (_options, action) => action({ report() {} }, { isCancellationRequested: false }),
            registerCustomEditorProvider: () => ({ dispose() {} })
        },
        languages: { createDiagnosticCollection: () => diagnosticCollection },
        commands: { async executeCommand(command, ...args) { commands.push({ command, args }); } }
    };
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
    let editor, navigation, performanceDebug;
    try {
        // Each adapter has its own VS Code resource context, including dependency modules.
        for (const key of Object.keys(require.cache)) if (key.startsWith(path.resolve(__dirname, '../src') + path.sep) && !/xlfWorkerHost|documentSession/.test(key)) delete require.cache[key];
        editor = require('../src/xlfEditor');
        navigation = require('../src/qualityDiagnosticNavigation');
        performanceDebug = require('../src/performanceDebug');
    } finally { Module._load = originalLoad; }
    require('../src/documentSession').resetDocumentSessions();
    const messages = [], transfers = [], emitter = new EventEmitter();
    let receive, dispose;
    const panel = {
        webview: {
            cspSource: 'vscode-webview://stress',
            onDidReceiveMessage: callback => { receive = callback; },
            async postMessage(message) {
                const copy = structuredClone(message);
                messages.push(copy);
                transfers.push({ type: message.type, bytes: Buffer.byteLength(JSON.stringify(message)), items: message.items && message.items.length });
                emitter.emit('message', copy);
                return true;
            }
        },
        onDidDispose: callback => { dispose = callback; }
    };
    const provider = new editor.XliffEditorProvider({ subscriptions: [] });
    editor.XliffEditorProvider.qualityDiagnostics = diagnosticCollection;
    await provider.resolveCustomTextEditor(document, panel);
    return {
        root, uri, document, panel, provider, editor, navigation, performanceDebug, messages, transfers, diagnostics, commands, popups, statuses, vscode,
        send: message => receive(message),
        last: type => messages.findLast(message => message.type === type),
        waitFor(predicate, after = 0, timeoutMs = 30000) {
            const found = messages.slice(after).find(predicate);
            if (found) return Promise.resolve(found);
            return new Promise((resolve, reject) => {
                const listener = message => { if (predicate(message)) { clearTimeout(timer); emitter.off('message', listener); resolve(message); } };
                const timer = setTimeout(() => { emitter.off('message', listener); reject(new Error('Timed out waiting for editor message')); }, timeoutMs);
                emitter.on('message', listener);
            });
        },
        externalChange(next) { value = next; lines = undefined; document.version++; onChange.fire({ document, contentChanges: [{}] }); },
        close() { dispose(); onClose.fire(document); },
        getErrors() { return messages.filter(message => message.type === 'error'); }
    };
}

function generateLargeXliff(unitCount = 30000, targetBytes = 15 * 1024 * 1024) {
    const header = '<?xml version="1.0" encoding="utf-8"?>\n<xliff version="1.2"><file source-language="en-US" target-language="de-DE" original="Stress"><body>\n';
    const footer = '</body></file></xliff>\n';
    const units = [];
    for (let i = 0; i < unitCount; i++) {
        const source = `Customer ${String(i).padStart(5, '0')} %1.`;
        const target = i % 11 === 0 ? '' : i % 10 === 0 ? `Kunde ${i} %2` : `Kunde ${i} %1.`;
        const state = i % 7 === 0 ? '' : ' state="translated"';
        units.push(`<trans-unit id="U${i}"><source>${source}</source><target${state}>${target}</target><note from="Xliff Generator">Table ${i + 1} - Property 2879900210</note><note from="Developer">Stress fixture UNIT ${i} PADDING</note></trans-unit>\n`);
    }
    const baseLength = Buffer.byteLength(header + units.join('') + footer);
    const padding = Math.max(0, Math.floor((targetBytes - baseLength) / unitCount));
    return header + units.map(unit => unit.replace('PADDING', 'x'.repeat(padding))).join('') + footer;
}

module.exports = { createEditorHarness, generateLargeXliff };
