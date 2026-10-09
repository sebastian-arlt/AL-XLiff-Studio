'use strict';
const { t } = require('./localization');

/** @typedef {'new-language'|'translate-missing'|'review'|'quality-fix'|'skipped'} GuidedWorkflow */
/** @typedef {'apply'|'skip'|'draft'|'ai'|'save'|'finish'|'restart'|'useProposal'|'previous'|'next'|'checkpoint'} GuidedAction */

// A transport adapter around the real XLIFF editor host. It owns navigation only;
// XML edits, validation, staging, AI, glossary and quality remain in that host.
class GuidedWorkflowSession {
    constructor(document, provider, onState = () => {}) {
        this.document = document;
        this.provider = provider;
        this.onState = onState;
        this.version = Number(document.version);
        this.drafts = new Map();
        this.queue = [];
        this.position = 0;
        this.accepted = 0;
        this.skipped = 0;
        this.revision = 0;
        this.phase = 'start';
        this.active = true;
        this.disposers = [];
        this.acceptedOrdinals = new Set();
        this.skippedOrdinals = new Set();
        this.seenOrdinals = new Set();
    }

    async connect() {
        const panel = {
            webview: {
                onDidReceiveMessage: handler => { this.receive = handler; },
                postMessage: async message => { this.handleHost(message); return true; }
            },
            onDidDispose: handler => { this.disposers.push(handler); }
        };
        await this.provider.resolveCustomTextEditor(this.document, panel, { headless: true });
        await this.send({ type: 'ready' });
        if (!this.metadata) throw new Error(t("The XLIFF could not be loaded."));
    }

    handleHost(message) {
        if (this.disposed) return;
        if (message.type === 'error') this.error = message.message;
        if (message.type === 'document') {
            this.metadata = message;
            if (this.version !== Number(message.documentVersion)) this.conflict = true;
        }
        if (message.type === 'guidedQueue') this.queue = message.ordinals;
        if (message.type === 'guidedRow') this.current = message.row;
        if (message.type === 'guidedDraftPersisted') this.version = Number(message.documentVersion);
        if (message.type === 'qualityReport') this.quality = message.report;
        if (message.type === 'translationAccepted') {
            this.applied = message.ordinal;
            this.version = Number(message.documentVersion);
            this.drafts.delete(message.ordinal);
        }
        if (message.type === 'proposalUpdated' && this.current && this.current.ordinal === message.ordinal) {
            this.current = { ...this.current, proposal: message.proposal, proposalProvenance: message.provenance, proposalOrigin: message.origin };
            const draft = this.drafts.get(message.ordinal);
            // Keep an existing manual draft; the new AI proposal is a separate choice.
            if (!draft) this.drafts.set(message.ordinal, { ordinal: message.ordinal, id: this.current.id, source: this.current.source, translation: message.proposal, kind: 'proposal', provenance: message.provenance, origin: message.origin });
        }
        if (message.type === 'saveState') this.dirty = Boolean(message.dirty);
        if (!this.running) this.publish();
    }

    async send(message) {
        if (this.disposed) throw new Error(t("The wizard was closed."));
        this.error = '';
        await this.receive(message);
        if (this.error) throw new Error(this.error);
    }

    state() {
        return {
            type: 'guidedState', phase: this.phase, workflow: this.workflow,
            row: this.current ? { ...this.current, localDraft: this.drafts.get(this.current.ordinal) } : undefined,
            total: this.queue.length, position: this.position, visited: this.seenOrdinals.size, accepted: this.accepted,
            skipped: this.skipped, summary: this.summary, canPrevious: this.position > 0 && this.phase !== 'summary', canNext: this.phase === 'entry' && this.position < this.queue.length - 1, drafts: this.drafts.size,
            dirty: Boolean(this.document.isDirty), conflict: Boolean(this.conflict || this.version !== Number(this.document.version)),
            busy: Boolean(this.running), error: this.error || '', quality: this.quality,
            sourceLanguage: this.metadata && this.metadata.sourceLanguage,
            targetLanguage: this.metadata && this.metadata.targetLanguage,
            readOnly: Boolean(this.metadata && this.metadata.readOnly), revision: this.revision
        };
    }

    publish() { if (!this.disposed && this.active && this.workflow) this.onState(this.state()); }

    async start(workflow) {
        if (!['new-language', 'translate-missing', 'review', 'quality-fix', 'skipped'].includes(workflow)) throw new Error(t("Unknown workflow."));
        if (workflow === 'skipped') this.assertCurrent({ revision: this.revision });
        if (this.drafts.size) throw new Error(t("Please save drafts or finish the current workflow first."));
        this.running = true;
        this.active = true;
        try {
            const refreshNeeded = Boolean(this.workflow) || this.version !== Number(this.document.version);
            this.workflow = workflow;
            this.version = Number(this.document.version);
            this.conflict = false;
            if (refreshNeeded) await this.send({ type: 'refresh' });
            if (this.metadata.readOnly) throw new Error(t("This XLIFF is read-only."));
            // Quality selection must use a completed host report, including large files.
            if (workflow === 'quality-fix') await this.send({ type: 'validateQuality' });
            const skipped = [...this.skippedOrdinals];
            await this.send({ type: 'guidedQueue', workflow, ordinals: skipped });
            this.position = this.accepted = this.skipped = 0;
            this.acceptedOrdinals.clear(); this.skippedOrdinals.clear(); this.seenOrdinals.clear(); this.summary = undefined;
            await this.next();
        } finally { this.running = false; this.publish(); }
    }

    async importLocal() {
        if (this.running || this.drafts.size) throw new Error(t("Please finish running actions and drafts first."));
        this.assertCurrent({ revision: this.revision });
        this.running = true;
        try {
            await this.send({ type: 'refresh' });
            await this.send({ type: 'tryFile', localOnly: true });
            this.version = Number(this.document.version);
            this.conflict = false;
        } finally { this.running = false; }
    }

    async persistDrafts() {
        for (const draft of this.drafts.values()) {
            if (draft.kind === 'draft') await this.send({ type: 'guidedPersistDraft', ...draft, text: draft.translation, documentVersion: this.version });
        }
    }

    async collectSummary() {
        await this.send({ type: 'refresh' });
        this.conflict = false;
        const queue = this.queue;
        await this.send({ type: 'guidedQueue', workflow: 'review' });
        const review = this.queue.length;
        this.queue = queue;
        const stats = this.metadata.stats || {};
        this.summary = { missing: stats.missing || 0, review, drafts: stats.translationDrafts || 0,
            proposals: stats.proposals || 0, skipped: this.skippedOrdinals.size,
            unvisited: this.queue.filter(ordinal => !this.seenOrdinals.has(ordinal)).length,
            quality: this.quality && this.quality.summary ? this.quality.summary.total : stats.qualityIssues || 0 };
    }

    async next() {
        this.revision++;
        this.current = undefined;
        if (this.position >= this.queue.length) { this.phase = 'complete'; return; }
        this.phase = 'entry';
        this.seenOrdinals.add(this.queue[this.position]);
        await this.send({ type: 'guidedRow', ordinal: this.queue[this.position] });
        if (!this.current) throw new Error(t("The entry changed. Please reload."));
        if (this.current.hasTranslationDraft && !this.drafts.has(this.current.ordinal)) {
            this.drafts.set(this.current.ordinal, { ordinal: this.current.ordinal, id: this.current.id, source: this.current.source, kind: 'draft', translation: this.current.translationDraft, provenance: this.current.translationDraftProvenance, origin: this.current.translationDraftOrigin });
        }
    }

    assertCurrent(message) {
        if (this.conflict || this.version !== Number(this.document.version)) {
            this.conflict = true;
            throw new Error(t("The XLIFF changed outside this workflow. Your text remains visible. Copy it, then reload."));
        }
        if (this.metadata && this.metadata.readOnly) throw new Error(t("This XLIFF is read-only."));
        if (message.revision !== this.revision) throw new Error(t("This action belongs to an earlier entry."));
    }

    async stage(text, provenance, origin) {
        if (!this.current) throw new Error(t("No active entry."));
        const item = { ordinal: this.current.ordinal, id: this.current.id, source: this.current.source, kind: 'draft', translation: String(text), provenance, origin };
        await this.send({ type: 'translationDraftChanged', ordinal: item.ordinal, text: item.translation, hasDraft: true, revision: this.revision, provenance, origin });
        this.drafts.set(item.ordinal, item);
    }

    /** @param {{action:GuidedAction, revision:number, text?:string}} message */
    async act(message) {
        if (this.running) return;
        this.running = true;
        this.publish();
        try {
            if (message.action === 'restart') {
                // Explicitly labelled destructive recovery action in the UI.
                this.drafts.clear();
                this.version = Number(this.document.version);
                this.conflict = false;
                for (const dispose of this.disposers.splice(0)) dispose();
                this.metadata = undefined;
                await this.connect();
                await this.start(this.workflow);
                return;
            }
            this.assertCurrent(message);
            if (!['draft', 'useProposal', 'ai', 'skip', 'apply', 'save', 'finish', 'previous', 'next', 'checkpoint'].includes(message.action)) throw new Error(t("Unknown wizard action."));
            if (this.current && typeof message.text === 'string' && message.action !== 'draft') {
                const local = this.drafts.get(this.current.ordinal);
                const previous = local && local.kind === 'draft' ? local.translation : this.current.hasTranslationDraft ? this.current.translationDraft : this.current.translation;
                if (message.text !== previous) await this.stage(message.text);
            }
            if (message.action === 'checkpoint') {
                await this.persistDrafts();
                this.drafts.clear();
                await this.send({ type: 'refresh' });
                this.conflict = false;
                if (this.current) await this.send({ type: 'guidedRow', ordinal: this.current.ordinal });
            } else if (message.action === 'previous' || message.action === 'next') {
                const target = this.position + (message.action === 'previous' ? -1 : 1);
                if (target < 0 || target >= this.queue.length) throw new Error(t("No further entry in this direction."));
                await this.persistDrafts();
                await this.send({ type: 'refresh' });
                this.conflict = false;
                this.position = target;
                await this.next();
            } else if (message.action === 'draft') await this.stage(message.text || '');
            else if (message.action === 'useProposal') {
                if (!this.current || !this.current.proposal) throw new Error(t("No proposal available."));
                await this.stage(this.current.proposal, this.current.proposalProvenance, this.current.proposalOrigin);
            } else if (message.action === 'ai') {
                if (!this.current) throw new Error(t("No active entry."));
                await this.send({ type: 'aiTranslate', ordinal: this.current.ordinal });
                this.version = Number(this.document.version);
            } else if (message.action === 'skip') {
                if (!this.current) throw new Error(t("No active entry."));
                const draft = this.drafts.get(this.current.ordinal);
                if (draft && draft.kind === 'draft') await this.send({ type: 'guidedPersistDraft', ...draft, text: draft.translation, documentVersion: this.version });
                this.skippedOrdinals.add(this.current.ordinal);
                this.skipped = this.skippedOrdinals.size; this.position++; await this.next();
            } else if (message.action === 'apply') {
                if (!this.current) throw new Error(t("No active entry."));
                const row = this.current;
                const local = this.drafts.get(row.ordinal);
                const translation = typeof message.text === 'string' ? message.text : local && local.kind === 'draft' ? local.translation : row.translation;
                this.applied = undefined;
                await this.send({ type: 'acceptTranslation', ordinal: row.ordinal, id: row.id, source: row.source,
                    translation, translationDirty: Boolean(local && local.kind === 'draft') || translation !== row.translation,
                    provenance: local && local.kind === 'draft' ? local.provenance : row.hasTranslationDraft && translation === row.translationDraft ? row.translationDraftProvenance : undefined,
                    origin: local && local.kind === 'draft' ? local.origin : row.hasTranslationDraft && translation === row.translationDraft ? row.translationDraftOrigin : undefined,
                    revision: this.revision, documentVersion: this.version,
                    targetLanguage: this.metadata.targetLanguage, state: row.rawState,
                    wasMissing: row.missing, wasReview: row.review });
                if (this.applied !== row.ordinal) throw new Error(t("No change applied. Edit or skip the entry."));
                this.acceptedOrdinals.add(row.ordinal); this.skippedOrdinals.delete(row.ordinal);
                this.accepted = this.acceptedOrdinals.size; this.skipped = this.skippedOrdinals.size; this.position++; await this.next();
            } else if (message.action === 'save' || message.action === 'finish') {
                const currentDraft = this.current && this.drafts.get(this.current.ordinal);
                await this.send({ type: 'saveDocument', items: [...this.drafts.values()], documentVersion: this.version });
                if (this.document.isDirty) throw new Error(t("The file was not saved."));
                this.version = Number(this.document.version);
                this.drafts.clear();
                if (currentDraft && currentDraft.kind === 'draft') this.current = { ...this.current, hasTranslationDraft: true, translationDraft: currentDraft.translation, translationDraftProvenance: currentDraft.provenance, translationDraftOrigin: currentDraft.origin };
                if (message.action === 'finish') {
                    await this.send({ type: 'validateQuality' });
                    await this.collectSummary();
                    this.phase = 'summary';
                    this.current = undefined;
                }
            }
        } catch (error) {
            this.error = error.message || String(error);
        } finally { this.running = false; this.publish(); }
    }

    dispose() {
        this.disposed = true;
        for (const dispose of this.disposers.splice(0)) dispose();
    }
}

module.exports = { GuidedWorkflowSession };
