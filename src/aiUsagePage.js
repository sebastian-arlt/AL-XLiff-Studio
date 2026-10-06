'use strict';

const vscode = require('vscode');
const { setTabIcon } = require('./tabIcons');
const { BRAND_NAME, CONFIG_SECTION, AI_USAGE_VIEW_TYPE } = require('./identity');
const { getAiUsage, onDidChangeAiUsage } = require('./aiUsage');
const {
    loadWorkspaceAiUsage,
    findAiUsageFiles,
    resetWorkspaceAiUsage,
    isAiUsageTrackingEnabled,
    onDidChangePersistedAiUsage
} = require('./aiUsageStore');

class AiUsagePage {
    static currentPanel = undefined;
    static viewType = AI_USAGE_VIEW_TYPE;

    static createOrShow(context) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;
        if (AiUsagePage.currentPanel) {
            AiUsagePage.currentPanel.panel.reveal(column);
            void AiUsagePage.currentPanel.refresh();
            return AiUsagePage.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            AiUsagePage.viewType,
            `${BRAND_NAME} — AI Usage`,
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        AiUsagePage.currentPanel = new AiUsagePage(panel, context);
        return AiUsagePage.currentPanel;
    }

    constructor(panel, context) {
        setTabIcon(panel, context && context.extensionUri, vscode, 'ai');
        this.panel = panel;
        this.context = context;
        this.disposables = [];
        this.refreshGeneration = 0;
        panel.webview.html = this.getHtml(panel.webview);

        panel.onDidDispose(() => this.dispose(), null, this.disposables);
        panel.webview.onDidReceiveMessage(async message => {
            try {
                if (!message || !message.type) return;
                if (message.type === 'ready' || message.type === 'refresh') {
                    await this.refresh();
                    return;
                }
                if (message.type === 'openDataFile') {
                    await this.openDataFile();
                    return;
                }
                if (message.type === 'reset') {
                    const choice = await vscode.window.showWarningMessage(
                        `${BRAND_NAME}: delete the persisted AI usage statistics for this workspace?`,
                        { modal: true },
                        'Delete usage statistics'
                    );
                    if (choice === 'Delete usage statistics') {
                        await resetWorkspaceAiUsage();
                        await this.refresh();
                    }
                }
            } catch (err) {
                await panel.webview.postMessage({ type: 'error', message: formatError(err) });
            }
        }, null, this.disposables);

        this.disposables.push(onDidChangePersistedAiUsage(() => {
            if (this.panel.visible) void this.refresh();
        }));
        this.disposables.push(onDidChangeAiUsage(session => {
            if (this.panel.visible) void this.panel.webview.postMessage({ type: 'session', session });
        }));
        if (typeof vscode.workspace.onDidChangeConfiguration === 'function') {
            this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.ai.usage.enabled`)) {
                    if (this.panel.visible) void this.refresh();
                }
            }));
        }
    }

    dispose() {
        if (AiUsagePage.currentPanel === this) AiUsagePage.currentPanel = undefined;
        for (const disposable of this.disposables.splice(0)) {
            try { disposable.dispose(); } catch (_) { /* ignore */ }
        }
    }

    async refresh() {
        const generation = ++this.refreshGeneration;
        await this.panel.webview.postMessage({ type: 'loading', value: true });
        const persisted = await loadWorkspaceAiUsage();
        if (generation !== this.refreshGeneration) return;
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        await this.panel.webview.postMessage({
            type: 'usage',
            persisted,
            session: getAiUsage(),
            trackingEnabled: isAiUsageTrackingEnabled(config),
            refreshedAt: new Date().toLocaleTimeString()
        });
    }

    async openDataFile() {
        const files = await findAiUsageFiles();
        if (!files.length) {
            vscode.window.showInformationMessage(`${BRAND_NAME}: no persisted AI usage file exists yet.`);
            return;
        }
        let uri = files[0];
        if (files.length > 1) {
            const picked = await vscode.window.showQuickPick(files.map(item => ({
                label: vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(item, false) : item.fsPath,
                description: item.fsPath,
                uri: item
            })), { placeHolder: 'Select the AI usage data file to open' });
            if (!picked) return;
            uri = picked.uri;
        }
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    getHtml(webview) {
        const nonce = String(Date.now());
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${BRAND_NAME} — AI Usage</title>
<style>
*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family)}
header{position:sticky;top:0;z-index:5;padding:14px 16px 12px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.title-row{display:flex;align-items:center;gap:8px}.title-wrap{flex:1}.title{font-size:1.25em;font-weight:650}.subtitle,.muted{color:var(--vscode-descriptionForeground)}
button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:1px solid var(--vscode-button-border,var(--vscode-panel-border));border-radius:2px;padding:5px 8px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-foreground);background:var(--vscode-input-background)}button.danger{color:var(--vscode-errorForeground);background:transparent}
.notice{margin:12px 16px 0;padding:9px 11px;border:1px solid var(--vscode-editorWarning-foreground);background:var(--vscode-inputValidation-warningBackground);display:none}.notice.show{display:block}
.summary{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:8px;padding:14px 16px}.card{border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:10px 12px;border-radius:3px}.card .value{font-size:1.35em;font-weight:650;font-variant-numeric:tabular-nums}.card .label{margin-top:2px;color:var(--vscode-descriptionForeground);font-size:.82em}
.section{margin:0 16px 16px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);border-radius:3px;overflow:hidden}.section h2{font-size:1em;margin:0;padding:9px 11px;border-bottom:1px solid var(--vscode-panel-border)}.section-body{padding:0 11px 10px}.section-note{padding:8px 11px;color:var(--vscode-descriptionForeground);font-size:.82em}
table{width:100%;border-collapse:collapse;table-layout:auto}th,td{padding:7px 6px;border-bottom:1px solid var(--vscode-panel-border);text-align:left;vertical-align:top}th{font-weight:600;color:var(--vscode-descriptionForeground);font-size:.86em}.number{text-align:right;font-variant-numeric:tabular-nums}.nowrap{white-space:nowrap}.empty{padding:14px 4px;color:var(--vscode-descriptionForeground)}
.session-grid{display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:8px;padding-top:10px}.session-stat{border-left:2px solid var(--vscode-panel-border);padding-left:9px}.session-stat strong{display:block;font-size:1.08em;font-variant-numeric:tabular-nums}.session-stat span{color:var(--vscode-descriptionForeground);font-size:.8em}
.loading{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:color-mix(in srgb,var(--vscode-editor-background) 88%,transparent)}.loading.show{display:flex}.loading-card{padding:16px 20px;border:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}
@media(max-width:900px){.summary{grid-template-columns:repeat(3,1fr)}.session-grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><div class="title-row"><div class="title-wrap"><div class="title">AI Usage</div><div class="subtitle">Persistent token statistics for AL Xliff Studio translation requests</div></div><button id="openData" class="secondary" title="Open the persisted .alxliffstudio/ai-usage.json file">&lt;/&gt; Data</button><button id="refresh">↻ Refresh</button><button id="reset" class="danger" title="Delete persisted usage statistics">Reset</button></div></header>
<div id="notice" class="notice"></div>
<section id="summary" class="summary"></section>
<section class="section"><h2>Current VS Code session</h2><div class="section-body"><div id="session" class="session-grid"></div><div class="section-note">Session values reset when the Extension Host restarts. Persistent totals above are stored per AL project.</div></div></section>
<section class="section"><h2>Models</h2><div class="section-body"><div id="models"></div></div></section>
<section class="section"><h2>Language pairs</h2><div class="section-body"><div id="languages"></div></div></section>
<section class="section"><h2>Daily usage</h2><div class="section-body"><div id="days"></div></div></section>
<section class="section"><h2>Projects</h2><div class="section-body"><div id="projects"></div></div></section>
<section class="section"><h2>Recent AI requests</h2><div class="section-body"><div id="recent"></div><div class="section-note">The file keeps aggregate statistics plus the most recent 250 requests. Token counts use the selected VS Code model tokenizer and are not provider billing data.</div></div></section>
<div id="loading" class="loading"><div class="loading-card">Loading AI usage…</div></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();let model={persisted:{totals:{}},session:{}};const nf=new Intl.NumberFormat();
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function n(v){const x=Number(v);return nf.format(Number.isFinite(x)?x:0)}
function card(value,label){return '<div class="card"><div class="value">'+n(value)+'</div><div class="label">'+esc(label)+'</div></div>'}
function stat(value,label){return '<div class="session-stat"><strong>'+n(value)+'</strong><span>'+esc(label)+'</span></div>'}
function table(headers,rows){if(!rows.length)return '<div class="empty">No data yet.</div>';return '<table><thead><tr>'+headers.map(h=>'<th class="'+(h.number?'number ':'')+(h.nowrap?'nowrap':'')+'">'+esc(h.label)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>'}
function td(v,number,nowrap,title){return '<td class="'+(number?'number ':'')+(nowrap?'nowrap':'')+'"'+(title?' title="'+esc(title)+'"':'')+'>'+esc(v)+'</td>'}
function renderSummary(){const t=model.persisted.totals||{};document.getElementById('summary').innerHTML=card(t.requests,'Requests')+card(t.translationItems,'Translated items')+card(t.inputTokens,'Input tokens')+card(t.outputTokens,'Output tokens')+card(t.totalTokens,'Total tokens')+card((model.persisted.projects||[]).length,'Projects')}
function renderSession(){const s=model.session||{};document.getElementById('session').innerHTML=stat(s.requests,'Requests')+stat(s.translationItems,'Items')+stat(s.inputTokens,'Input tokens')+stat(s.outputTokens,'Output tokens')+stat(s.totalTokens,'Total tokens')}
function renderModels(){const rows=(model.persisted.models||[]).map(m=>'<tr>'+td(m.name||m.id||m.key,false,true,[m.vendor,m.family,m.version].filter(Boolean).join(' · '))+td(n(m.requests),true)+td(n(m.translationItems),true)+td(n(m.inputTokens),true)+td(n(m.outputTokens),true)+td(n(m.totalTokens),true)+td(m.requests?n(Math.round((Number(m.totalTokens)||0)/Number(m.requests))):'0',true)+'</tr>');document.getElementById('models').innerHTML=table([{label:'Model'},{label:'Requests',number:true},{label:'Items',number:true},{label:'Input',number:true},{label:'Output',number:true},{label:'Total',number:true},{label:'Avg / request',number:true}],rows)}
function renderLanguages(){const rows=(model.persisted.languagePairs||[]).map(p=>'<tr>'+td((p.sourceLanguage||'?')+' → '+(p.targetLanguage||'?'),false,true)+td(n(p.requests),true)+td(n(p.translationItems),true)+td(n(p.inputTokens),true)+td(n(p.outputTokens),true)+td(n(p.totalTokens),true)+'</tr>');document.getElementById('languages').innerHTML=table([{label:'Language pair'},{label:'Requests',number:true},{label:'Items',number:true},{label:'Input',number:true},{label:'Output',number:true},{label:'Total',number:true}],rows)}
function renderDays(){const values=(model.persisted.days||[]).slice().reverse().slice(0,60);const rows=values.map(d=>'<tr>'+td(d.date,false,true)+td(n(d.requests),true)+td(n(d.translationItems),true)+td(n(d.inputTokens),true)+td(n(d.outputTokens),true)+td(n(d.totalTokens),true)+'</tr>');document.getElementById('days').innerHTML=table([{label:'Date'},{label:'Requests',number:true},{label:'Items',number:true},{label:'Input',number:true},{label:'Output',number:true},{label:'Total',number:true}],rows)}
function renderProjects(){const rows=(model.persisted.projects||[]).map(p=>'<tr>'+td(p.project,false,true,p.uri)+td(n(p.requests),true)+td(n(p.translationItems),true)+td(n(p.totalTokens),true)+td(p.updatedAt?new Date(p.updatedAt).toLocaleString():'—',false,true)+'</tr>');document.getElementById('projects').innerHTML=table([{label:'Project'},{label:'Requests',number:true},{label:'Items',number:true},{label:'Tokens',number:true},{label:'Last update'}],rows)}
function renderRecent(){const rows=(model.persisted.recentRequests||[]).slice(0,100).map(r=>'<tr>'+td(r.timestamp?new Date(r.timestamp).toLocaleString():'—',false,true)+td(r.project||'')+td(r.modelName||r.modelId||'Unknown')+td((r.sourceLanguage||'?')+' → '+(r.targetLanguage||'?'),false,true)+td(n(r.translationItems),true)+td(r.inputTokens==null?'—':n(r.inputTokens),true)+td(r.outputTokens==null?'—':n(r.outputTokens),true)+td(n(r.totalTokens),true)+'</tr>');document.getElementById('recent').innerHTML=table([{label:'Time'},{label:'Project'},{label:'Model'},{label:'Languages'},{label:'Items',number:true},{label:'Input',number:true},{label:'Output',number:true},{label:'Total',number:true}],rows)}
function renderNotice(){const notice=document.getElementById('notice');if(model.trackingEnabled===false){notice.textContent='AI usage tracking is disabled by alXliffStudio.ai.usage.enabled. Existing persisted statistics remain available.';notice.classList.add('show')}else if((model.persisted.errors||[]).length){notice.textContent=model.persisted.errors.join(' | ');notice.classList.add('show')}else{notice.classList.remove('show');notice.textContent=''}}
function render(){renderSummary();renderSession();renderModels();renderLanguages();renderDays();renderProjects();renderRecent();renderNotice()}
document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.getElementById('openData').addEventListener('click',()=>vscode.postMessage({type:'openDataFile'}));document.getElementById('reset').addEventListener('click',()=>vscode.postMessage({type:'reset'}));
window.addEventListener('message',e=>{const msg=e.data;if(msg.type==='loading'){document.getElementById('loading').classList.toggle('show',Boolean(msg.value));}else if(msg.type==='usage'){model=msg;document.getElementById('loading').classList.remove('show');render();}else if(msg.type==='session'){model.session=msg.session||{};renderSession();}else if(msg.type==='error'){document.getElementById('loading').classList.remove('show');const notice=document.getElementById('notice');notice.textContent=msg.message||'AI usage error.';notice.classList.add('show')}});vscode.postMessage({type:'ready'});
</script></body></html>`;
    }
}

function formatError(err) {
    return err instanceof Error ? err.message : String(err || 'Unknown error');
}

module.exports = { AiUsagePage };
