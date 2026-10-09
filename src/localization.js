'use strict';

// Only extension-owned UI messages are passed here. XLIFF content, technical
// identifiers and persisted workflow metadata must never be translated.
const german = require('../l10n/bundle.l10n.de.json');
let vscode;
try { vscode = require('vscode'); } catch (_) { /* Workers use English. */ }

function uiLanguage() {
    return /^de(?:-|$)/i.test(String(vscode && vscode.env && vscode.env.language || 'en')) ? 'de' : 'en';
}

function t(message, ...args) {
    if (vscode && vscode.l10n && typeof vscode.l10n.t === 'function') {
        return vscode.l10n.t(message, ...args);
    }
    const translated = uiLanguage() === 'de' ? german[message] || message : message;
    return translated.replace(/\{(\d+)\}/g, (placeholder, index) => index < args.length ? String(args[index]) : placeholder);
}

function htmlText(message, ...args) {
    return t(message, ...args).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
}

function scriptString(message, ...args) {
    const value = t(message, ...args).replace(/[\\'\u0000-\u001f\u2028\u2029<]/g, character => {
        if (character === '\\') return '\\\\';
        if (character === "'") return "\\'";
        return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
    });
    return "'" + value + "'";
}

let messagePatterns;
function localizeMessage(message) {
    const value = String(message || '');
    if (uiLanguage() !== 'de') return value;
    if (Object.hasOwn(german, value)) return t(value);
    if (!messagePatterns) {
        messagePatterns = Object.keys(german).filter(key => /\{\d+\}/.test(key)).map(key => {
            const parts = key.split(/(\{\d+\})/);
            const slots = [];
            const pattern = parts.map(part => {
                if (/^\{\d+\}$/.test(part)) { slots.push(Number(part.slice(1, -1))); return '([\\s\\S]*?)'; }
                return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }).join('');
            return { key, prefix: parts[0], slots, pattern: new RegExp('^' + pattern + '$') };
        });
    }
    for (const entry of messagePatterns) {
        if (!value.startsWith(entry.prefix)) continue;
        const match = entry.pattern.exec(value);
        if (!match) continue;
        const args = [];
        entry.slots.forEach((slot, index) => { args[slot] = match[index + 1]; });
        return t(entry.key, ...args);
    }
    return value;
}

// Worker results carry English findings. Localize only their display messages;
// IDs, severity, source/target strings and ordinal indexes remain untouched.
function localizeQualityReport(report) {
    if (uiLanguage() !== 'de' || !report) return report;
    const seen = new Set();
    for (const issue of [...(report.issues || []), ...(report.ignoredIssues || [])]) {
        if (seen.has(issue)) continue;
        seen.add(issue);
        issue.message = localizeMessage(issue.message);
    }
    return report;
}

module.exports = { t, htmlText, scriptString, uiLanguage, localizeMessage, localizeQualityReport };
