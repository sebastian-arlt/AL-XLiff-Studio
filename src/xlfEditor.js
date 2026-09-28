'use strict';

const vscode = require('vscode');
const { BRAND_NAME, CONFIG_SECTION, XLIFF_EDITOR_VIEW_TYPE } = require('./identity');
const path = require('path');
const { parseLng, serializeLng, mergeEntries, entriesToMap } = require('./lng');
const {
    parseXliff,
    isMissingTranslation,
    isReviewTranslation,
    updateTranslationUnit,
    flagSourceChangedUnits,
    extractPlaceholders,
    placeholdersMatch,
    translatedPairs
} = require('./xliff');
const { resolveKnownTranslationForUnit } = require('./resolver');
const { translateItems } = require('./ai');
const { findDuplicateIds, findDuplicateGeneratorNotes } = require('./validate');
const { getGeneratorCompanionFilename } = require('./paths');
const { synchronizeTranslationUnits } = require('./synchronize');

const ROW_PREPARE_CHUNK_SIZE = 200;

class XliffEditorProvider {
    static viewType = XLIFF_EDITOR_VIEW_TYPE;

    constructor(context) {
        this.context = context;
    }

    static register(context) {
        const provider = new XliffEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(XliffEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: true
        });
    }

    async resolveCustomTextEditor(document, webviewPanel) {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);
        let applyingFromWebview = false;
        let suppressNextDocumentChange = false;
        let disposed = false;
        const proposalCache = new Map();
        let documentLoadId = 0;

        const postError = message => {
            if (!disposed) webviewPanel.webview.postMessage({ type: 'error', message: String(message || '') });
        };

        const loadCompanionMap = async parsed => {
            const language = parsed.targetLanguage;
            if (!language) return new Map();
            const mapUri = getMapUriForXlf(document.uri, language);
            try {
                return entriesToMap(parseLng(await readText(mapUri)).entries);
            } catch (err) {
                if (isFileNotFound(err)) return new Map();
                return new Map();
            }
        };

        const postDocument = async () => {
            if (disposed) return;
            const loadId = ++documentLoadId;
            const sourceText = document.getText();
            const estimatedUnits = countTransUnitsFast(sourceText);
            const showLoadingProgress = estimatedUnits > 0;
            if (showLoadingProgress) {
                await webviewPanel.webview.postMessage({
                    type: 'loadStart',
                    loadId,
                    stage: 'Reading XLIFF',
                    current: 0,
                    total: estimatedUnits
                });
                await yieldToEventLoop();
            }

            const parsed = parseXliff(sourceText);
            const readOnly = isGeneratorXliff(document.uri, parsed);
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
            const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
            const rows = [];
            let missingCount = 0;
            let reviewCount = 0;
            let proposalCount = 0;

            if (showLoadingProgress) {
                await webviewPanel.webview.postMessage({
                    type: 'loadProgress',
                    loadId,
                    stage: 'Preparing rows',
                    current: 0,
                    total: parsed.units.length
                });
                await yieldToEventLoop();
            }

            for (let unitIndex = 0; unitIndex < parsed.units.length; unitIndex++) {
                const unit = parsed.units[unitIndex];
                const notTranslatable = String(unit.translate || '').trim().toLowerCase() === 'no';
                const missing = !notTranslatable && isMissingTranslation(unit, treatNeedsTranslationAsMissing);
                const review = !notTranslatable && isReviewTranslation(unit);
                if (missing) missingCount++;
                if (review) reviewCount++;

                let cached = proposalCache.get(unit.ordinal);
                if (cached && cached.source !== unit.source) {
                    proposalCache.delete(unit.ordinal);
                    cached = undefined;
                }

                if (cached && cached.text) proposalCount++;
                const target = unit.target === undefined ? '' : unit.target;
                const maxWidthExceeded = Number.isFinite(unit.maxWidth) && target.length > unit.maxWidth;
                const translationPlaceholderValidation = getPlaceholderValidation(unit.source, target);
                const proposalPlaceholderValidation = getPlaceholderValidation(unit.source, cached ? cached.text : '');
                rows.push({
                    ordinal: unit.ordinal,
                    id: unit.id,
                    source: unit.source,
                    translation: target,
                    targetExists: unit.target !== undefined,
                    status: displayStatus(unit),
                    rawState: unit.targetState || '',
                    translate: unit.translate || '',
                    notTranslatable,
                    missing,
                    review,
                    notes: unit.noteDetails || [],
                    proposal: cached ? cached.text : '',
                    proposalOrigin: cached ? cached.origin : '',
                    maxWidth: unit.maxWidth,
                    maxWidthExceeded,
                    translationPlaceholderError: translationPlaceholderValidation.error,
                    proposalPlaceholderError: proposalPlaceholderValidation.error,
                    canConfirmReview: !readOnly && !notTranslatable && String(unit.targetState || '').toLowerCase() === 'needs-review-translation' && Boolean(target)
                });

                if (showLoadingProgress && ((unitIndex + 1) % ROW_PREPARE_CHUNK_SIZE === 0 || unitIndex + 1 === parsed.units.length)) {
                    await webviewPanel.webview.postMessage({
                        type: 'loadProgress',
                        loadId,
                        stage: 'Preparing rows',
                        current: unitIndex + 1,
                        total: parsed.units.length
                    });
                    await yieldToEventLoop();
                }
            }

            const duplicateIds = findDuplicateIds(parsed);
            const duplicateNotes = findDuplicateGeneratorNotes(parsed);
            const warnings = [];
            if (duplicateIds.length) warnings.push(`Duplicate trans-unit ids: ${duplicateIds.join(', ')}`);
            if (duplicateNotes.length) warnings.push(`${duplicateNotes.length} duplicate Xliff Generator note(s)`);

            await webviewPanel.webview.postMessage({
                type: 'document',
                loadId,
                largeDocument: showLoadingProgress,
                rows,
                sourceLanguage: parsed.sourceLanguage || '',
                targetLanguage: parsed.targetLanguage || '',
                readOnly,
                generated: isGeneratorFilename(document.uri),
                stats: {
                    total: rows.length,
                    missing: missingCount,
                    review: reviewCount,
                    proposals: proposalCount
                },
                warnings
            });
        };

        const applyText = async newText => {
            if (document.getText() === newText) return false;
            const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, fullRange, newText);
            applyingFromWebview = true;
            suppressNextDocumentChange = true;
            try {
                const applied = await vscode.workspace.applyEdit(edit);
                if (!applied) suppressNextDocumentChange = false;
                return applied;
            } finally {
                applyingFromWebview = false;
            }
        };

        const writeAcceptedToMap = async accepted => {
            const parsed = parseXliff(document.getText());
            if (!parsed.targetLanguage || !accepted.length) return;
            const candidates = new Map();
            for (const item of accepted) {
                if (!item.source || !item.translation) continue;
                if (!candidates.has(item.source)) candidates.set(item.source, new Set());
                candidates.get(item.source).add(item.translation);
            }
            const additions = [];
            for (const [source, translations] of candidates) {
                if (translations.size === 1) additions.push({ source, translation: [...translations][0] });
            }
            if (!additions.length) return;

            const mapUri = getMapUriForXlf(document.uri, parsed.targetLanguage);
            let existing = { entries: [] };
            try {
                existing = parseLng(await readText(mapUri));
            } catch (err) {
                if (!isFileNotFound(err)) throw err;
            }
            const merged = mergeEntries(existing.entries, additions, { overwrite: true });
            await writeText(mapUri, serializeLng(merged.entries, parsed.targetLanguage));
        };

        const updateCompanionMapFromXliffTexts = async xlfTexts => {
            const parsedCurrent = parseXliff(document.getText());
            if (!parsedCurrent.targetLanguage) return { pairCount: 0, conflictCount: 0 };

            const mapUri = getMapUriForXlf(document.uri, parsedCurrent.targetLanguage);
            let existing = { entries: [] };
            try {
                existing = parseLng(await readText(mapUri));
            } catch (err) {
                if (!isFileNotFound(err)) throw err;
            }

            const result = mergeTranslationMemoryFromXliffTexts(existing.entries, xlfTexts);
            await writeText(mapUri, serializeLng(result.entries, parsedCurrent.targetLanguage));
            return result;
        };

        const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() !== document.uri.toString()) return;
            if (suppressNextDocumentChange) {
                suppressNextDocumentChange = false;
                return;
            }
            if (!applyingFromWebview) void postDocument();
        });

        webviewPanel.onDidDispose(() => {
            disposed = true;
            changeSubscription.dispose();
        });

        webviewPanel.webview.onDidReceiveMessage(async message => {
            try {
                if (message.type === 'ready' || message.type === 'refresh') {
                    await postDocument();
                    return;
                }
                if (message.type === 'searchSource') {
                    const source = typeof message.source === 'string' ? message.source : '';
                    if (source) await vscode.commands.executeCommand('workbench.action.findInFiles', createFindInFilesArgs(source));
                    return;
                }
                if (message.type === 'openText') {
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                    return;
                }

                const parsed = parseXliff(document.getText());
                const readOnly = isGeneratorXliff(document.uri, parsed);
                if (readOnly) {
                    postError('Generated/source XLIFF files are read-only in the AL Xliff Studio XLIFF Editor.');
                    return;
                }

                if (message.type === 'synchronizeFile') {
                    webviewPanel.webview.postMessage({ type: 'syncBusy', busy: true });
                    try {
                        const siblingUri = await findSiblingGxlf(document.uri, parsed.targetLanguage);
                        if (!siblingUri) {
                            postError('No unambiguous matching *.g.xlf file was found next to this translation XLIFF.');
                            return;
                        }
                        const beforeSyncText = document.getText();
                        const result = synchronizeTranslationUnits(beforeSyncText, await readText(siblingUri));

                        // Preserve confirmed translations from the pre-sync source text before
                        // changed sources are rewritten/flagged. This gives fuzzy matching a
                        // stable old-source -> translation basis even when the .lng did not
                        // exist before synchronization. Afterwards merge the synchronized file
                        // as well, so the companion .lng is created/updated in the same action.
                        const mapResult = await updateCompanionMapFromXliffTexts([beforeSyncText, result.text]);

                        if (result.text !== beforeSyncText) {
                            await applyText(result.text);
                        }
                        // Synchronization can add units and therefore changes ordinal-based
                        // proposal identities. Clearing proposals is safer than attaching a
                        // proposal to the wrong trans-unit afterwards.
                        proposalCache.clear();
                        await postDocument();
                        const obsoleteSuffix = result.obsoleteUnits.length
                            ? ` ${result.obsoleteUnits.length} obsolete translation unit(s) were kept and not deleted.`
                            : '';
                        const mapSuffix = ` Companion .lng updated from ${mapResult.pairCount} confirmed translation pair(s).`;
                        vscode.window.showInformationMessage(
                            `AL Xliff Studio: synchronized ${result.synchronizedSources} changed source(s), added ${result.addedUnits} missing unit(s), flagged ${result.flaggedTargets} existing target(s) for review.${obsoleteSuffix}${mapSuffix}`
                        );
                    } finally {
                        webviewPanel.webview.postMessage({ type: 'syncBusy', busy: false });
                    }
                    return;
                }

                if (message.type === 'tryFile') {
                    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                    const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
                    const missingUnits = parsed.units.filter(unit => isMissingTranslation(unit, treatNeedsTranslationAsMissing));
                    if (!missingUnits.length) {
                        vscode.window.showInformationMessage('AL Xliff Studio: no missing translations in this XLIFF.');
                        return;
                    }

                    webviewPanel.webview.postMessage({ type: 'tryBusy', all: true, busy: true });
                    try {
                        const companionMap = await loadCompanionMap(parsed);
                        const fuzzyOptions = {
                            enabled: config.get('fuzzyMatch.enabled', false),
                            minimumQuality: config.get('fuzzyMatch.minimumQuality', 80)
                        };
                        const bySource = new Map();
                        for (const candidate of missingUnits) {
                            if (!bySource.has(candidate.source)) bySource.set(candidate.source, []);
                            bySource.get(candidate.source).push(candidate);
                        }

                        const stagedTranslations = [];
                        const unresolved = [];
                        let fuzzyProposals = 0;

                        for (const candidate of missingUnits) {
                            const resolved = resolveKnownTranslationForUnit(
                                candidate,
                                bySource.get(candidate.source) || [candidate],
                                parsed.targetLanguage,
                                companionMap,
                                fuzzyOptions
                            );
                            if (!resolved.translation) {
                                unresolved.push(candidate);
                                continue;
                            }

                            if (resolved.source === 'fuzzy') {
                                proposalCache.set(candidate.ordinal, {
                                    source: candidate.source,
                                    text: resolved.translation,
                                    origin: `Fuzzy ${resolved.quality}%`
                                });
                                fuzzyProposals++;
                                continue;
                            }

                            stagedTranslations.push({
                                ordinal: candidate.ordinal,
                                source: candidate.source,
                                translation: resolved.translation,
                                origin: resolved.source === 'comment' ? 'Developer comment' : '.lng'
                            });
                            proposalCache.delete(candidate.ordinal);
                        }

                        let aiProposals = 0;
                        if (unresolved.length && config.get('ai.enabled', true) !== false) {
                            const choice = await vscode.window.showWarningMessage(
                                `${unresolved.length} open translation${unresolved.length === 1 ? '' : 's'}`,
                                { modal: true },
                                'Use AI',
                                'Continue without AI'
                            );
                            if (choice === 'Use AI') {
                                await vscode.window.withProgress({
                                    location: vscode.ProgressLocation.Notification,
                                    title: 'AL Xliff Studio: creating AI drafts',
                                    cancellable: true
                                }, async (progress, token) => {
                                    progress.report({ message: `0 / ${unresolved.length}` });
                                    const aiResult = await translateItems(
                                        unresolved.map(candidate => ({
                                            key: candidate.id || `unit-${candidate.ordinal}`,
                                            source: candidate.source,
                                            context: (candidate.noteDetails || [])
                                                .map(note => [note.from, note.text].filter(Boolean).join(': '))
                                                .join(' | ')
                                        })),
                                        parsed.sourceLanguage,
                                        parsed.targetLanguage,
                                        token,
                                        (completed, total) => progress.report({
                                            message: `${completed} / ${total}`,
                                            increment: total ? (100 * completed / total) : 0
                                        })
                                    );
                                    for (const candidate of unresolved) {
                                        const suggestion = aiResult.get(candidate.source);
                                        if (!suggestion) continue;
                                        proposalCache.set(candidate.ordinal, {
                                            source: candidate.source,
                                            text: suggestion,
                                            origin: 'AI'
                                        });
                                        aiProposals++;
                                    }
                                });
                            }
                        }

                        await postDocument();
                        if (stagedTranslations.length) {
                            await webviewPanel.webview.postMessage({
                                type: 'stageTranslationDrafts',
                                items: stagedTranslations
                            });
                        }
                        const unresolvedAfter = unresolved.length - aiProposals;
                        vscode.window.showInformationMessage(
                            `AL Xliff Studio: ${stagedTranslations.length} direct translation draft(s), ${fuzzyProposals} fuzzy proposal draft(s), ${aiProposals} AI proposal draft(s)${unresolvedAfter > 0 ? `, ${unresolvedAfter} still open` : ''}. Use Apply Drafts to write staged changes as translated.`
                        );
                    } finally {
                        webviewPanel.webview.postMessage({ type: 'tryBusy', all: true, busy: false });
                    }
                    return;
                }

                const ordinal = Number(message.ordinal);
                const unit = Number.isInteger(ordinal) ? parsed.units[ordinal] : undefined;

                if (message.type === 'proposalChanged') {
                    if (!unit) return;
                    const text = typeof message.text === 'string' ? message.text : '';
                    if (text) proposalCache.set(ordinal, { source: unit.source, text, origin: 'Manual' });
                    else proposalCache.delete(ordinal);
                    return;
                }

                if (message.type === 'saveManyDrafts') {
                    const requested = Array.isArray(message.items) ? message.items : [];
                    let text = document.getText();
                    const accepted = [];
                    const saved = [];
                    const skipped = [];
                    for (const requestedItem of requested) {
                        const itemOrdinal = Number(requestedItem.ordinal);
                        const itemUnit = parsed.units[itemOrdinal];
                        const translation = typeof requestedItem.translation === 'string' ? requestedItem.translation : '';
                        if (!itemUnit || String(itemUnit.translate || '').trim().toLowerCase() === 'no') continue;
                        if (!translation) {
                            skipped.push({ ordinal: itemOrdinal, reason: 'empty translation' });
                            continue;
                        }
                        if (!placeholdersMatch(itemUnit.source, translation)) {
                            skipped.push({ ordinal: itemOrdinal, reason: 'placeholder mismatch' });
                            continue;
                        }
                        const result = updateTranslationUnit(text, itemOrdinal, {
                            translation,
                            state: 'translated'
                        });
                        if (!result.updatedCount) continue;
                        text = result.text;
                        accepted.push({ source: itemUnit.source, translation });
                        saved.push({ ordinal: itemOrdinal, translation, state: 'translated' });
                        proposalCache.delete(itemOrdinal);
                    }
                    if (saved.length) {
                        await applyText(text);
                        await writeAcceptedToMap(accepted);
                    }
                    await webviewPanel.webview.postMessage({ type: 'draftsSaved', items: saved, skipped });
                    await postDocument();
                    if (skipped.length) {
                        postError(`${skipped.length} draft(s) were not applied because they are empty or contain invalid placeholders.`);
                    }
                    return;
                }

                if (message.type === 'acceptMany') {
                    const requested = Array.isArray(message.items) ? message.items : [];
                    const staged = [];
                    for (const requestedItem of requested) {
                        const itemOrdinal = Number(requestedItem.ordinal);
                        const itemUnit = parsed.units[itemOrdinal];
                        const translation = typeof requestedItem.translation === 'string' ? requestedItem.translation : '';
                        if (!itemUnit || !translation || String(itemUnit.translate || '').trim().toLowerCase() === 'no') continue;
                        if (!placeholdersMatch(itemUnit.source, translation)) continue;
                        proposalCache.delete(itemOrdinal);
                        staged.push({ ordinal: itemOrdinal, translation });
                    }
                    if (staged.length) {
                        await webviewPanel.webview.postMessage({ type: 'proposalsAcceptedAsDrafts', items: staged });
                    }
                    return;
                }

                if (message.type === 'clearProposals') {
                    const ordinals = Array.isArray(message.ordinals) ? message.ordinals.map(Number) : [];
                    for (const itemOrdinal of ordinals) proposalCache.delete(itemOrdinal);
                    return;
                }


                if (!unit) return;
                if (String(unit.translate || '').trim().toLowerCase() === 'no') {
                    postError('This trans-unit has translate="no" and is not editable.');
                    return;
                }

                if (message.type === 'tryUnit') {
                    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                    const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
                    if (!isMissingTranslation(unit, treatNeedsTranslationAsMissing)) {
                        postError('This row is not missing a translation.');
                        return;
                    }

                    webviewPanel.webview.postMessage({ type: 'tryBusy', ordinal, busy: true });
                    try {
                        const companionMap = await loadCompanionMap(parsed);
                        const fuzzyOptions = {
                            enabled: config.get('fuzzyMatch.enabled', false),
                            minimumQuality: config.get('fuzzyMatch.minimumQuality', 80)
                        };
                        const sameSourceUnits = parsed.units.filter(candidate =>
                            candidate.source === unit.source && isMissingTranslation(candidate, treatNeedsTranslationAsMissing)
                        );
                        const resolved = resolveKnownTranslationForUnit(
                            unit,
                            sameSourceUnits.length ? sameSourceUnits : [unit],
                            parsed.targetLanguage,
                            companionMap,
                            fuzzyOptions
                        );

                        if (resolved.translation) {
                            if (resolved.source === 'fuzzy') {
                                proposalCache.set(ordinal, {
                                    source: unit.source,
                                    text: resolved.translation,
                                    origin: `Fuzzy ${resolved.quality}%`
                                });
                                await postDocument();
                            } else {
                                proposalCache.delete(ordinal);
                                await postDocument();
                                await webviewPanel.webview.postMessage({
                                    type: 'stageTranslationDrafts',
                                    items: [{
                                        ordinal,
                                        source: unit.source,
                                        translation: resolved.translation,
                                        origin: resolved.source === 'comment' ? 'Developer comment' : '.lng'
                                    }]
                                });
                            }
                            return;
                        }

                        if (config.get('ai.enabled', true) === false) {
                            postError('No Developer comment or exact .lng match was found; fuzzy matching did not produce a proposal, and AI is disabled.');
                            return;
                        }

                        const choice = await vscode.window.showWarningMessage(
                            '1 open translation',
                            { modal: true },
                            'Use AI',
                            'Continue without AI'
                        );
                        if (choice !== 'Use AI') return;

                        let suggestion;
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: 'AL Xliff Studio: creating AI draft',
                            cancellable: true
                        }, async (progress, token) => {
                            progress.report({ message: '0 / 1' });
                            const aiResult = await translateItems([{
                                key: unit.id || `unit-${ordinal}`,
                                source: unit.source,
                                context: (unit.noteDetails || []).map(note => [note.from, note.text].filter(Boolean).join(': ')).join(' | ')
                            }], parsed.sourceLanguage, parsed.targetLanguage, token);
                            suggestion = aiResult.get(unit.source);
                            if (suggestion) progress.report({ message: '1 / 1', increment: 100 });
                        });
                        if (!suggestion) {
                            postError('The AI did not return a usable translation. Check placeholders or model availability.');
                            return;
                        }
                        proposalCache.set(ordinal, { source: unit.source, text: suggestion, origin: 'AI' });
                        await postDocument();
                    } finally {
                        webviewPanel.webview.postMessage({ type: 'tryBusy', ordinal, busy: false });
                    }
                    return;
                }


                if (message.type === 'updateStatus') {
                    const state = message.state === '__none__' ? '' : String(message.state || '');
                    const completedState = ['translated', 'signed-off', 'final'].includes(state.toLowerCase());
                    if (completedState) {
                        if (!unit.target) {
                            postError(`Cannot mark an empty translation as ${state}: ${unit.source}`);
                            await postDocument();
                            return;
                        }
                        if (!placeholdersMatch(unit.source, unit.target)) {
                            postError(`Placeholders do not match for: ${unit.source}`);
                            await postDocument();
                            return;
                        }
                    }
                    const updated = updateTranslationUnit(document.getText(), ordinal, { state });
                    if (updated.updatedCount) {
                        await applyText(updated.text);
                        if (completedState) await writeAcceptedToMap([{ source: unit.source, translation: unit.target }]);
                    }
                    await postDocument();
                    return;
                }

                if (message.type === 'confirmReview') {
                    if (String(unit.targetState || '').trim().toLowerCase() !== 'needs-review-translation') {
                        postError('Only targets with state=needs-review-translation can be confirmed with this action.');
                        return;
                    }
                    const translation = unit.target || '';
                    if (!translation) {
                        postError(`Cannot confirm an empty translation for: ${unit.source}`);
                        return;
                    }
                    if (!placeholdersMatch(unit.source, translation)) {
                        postError(`Placeholders do not match for: ${unit.source}`);
                        return;
                    }
                    const updated = updateTranslationUnit(document.getText(), ordinal, { state: 'translated' });
                    if (updated.updatedCount) {
                        await applyText(updated.text);
                        await writeAcceptedToMap([{ source: unit.source, translation }]);
                    }
                    await postDocument();
                    return;
                }

                if (message.type === 'aiTranslate') {
                    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                    if (config.get('ai.enabled', true) === false) {
                        postError('AI translation is disabled in AL Xliff Studio settings.');
                        return;
                    }
                    webviewPanel.webview.postMessage({ type: 'aiBusy', ordinal, busy: true });
                    try {
                        const aiResult = await translateItems([{
                            key: unit.id || `unit-${ordinal}`,
                            source: unit.source,
                            context: (unit.noteDetails || []).map(note => [note.from, note.text].filter(Boolean).join(': ')).join(' | ')
                        }], parsed.sourceLanguage, parsed.targetLanguage, undefined);
                        const suggestion = aiResult.get(unit.source);
                        if (!suggestion) {
                            postError('The AI did not return a usable translation. Check placeholders or model availability.');
                            return;
                        }
                        proposalCache.set(ordinal, { source: unit.source, text: suggestion, origin: 'AI' });
                        await postDocument();
                    } finally {
                        webviewPanel.webview.postMessage({ type: 'aiBusy', ordinal, busy: false });
                    }
                    return;
                }

                if (message.type === 'acceptProposal') {
                    const translation = typeof message.translation === 'string' ? message.translation : '';
                    if (!translation) return;
                    if (!placeholdersMatch(unit.source, translation)) {
                        postError(`Placeholders do not match for: ${unit.source}`);
                        return;
                    }
                    proposalCache.delete(ordinal);
                    await webviewPanel.webview.postMessage({
                        type: 'proposalAcceptedAsDraft',
                        ordinal,
                        translation
                    });
                    return;
                }


            } catch (err) {
                postError(formatError(err));
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
<title>AL Xliff Studio — XLIFF Editor</title>
<style>
:root { --row-border: var(--vscode-panel-border); --chrome-height: 118px; }
* { box-sizing:border-box; }
body { padding:0; margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background); font-family:var(--vscode-font-family); }
.chrome { position:sticky; top:0; z-index:7; background:var(--vscode-editor-background); border-bottom:1px solid var(--row-border); box-shadow:0 1px 3px rgba(0,0,0,.08); }
.mainbar { display:flex; gap:12px; align-items:center; padding:9px 10px 7px; }
.identity { min-width:190px; flex:1; }
.title { font-size:1.05em; font-weight:600; line-height:1.35; }
.meta { margin-top:2px; color:var(--vscode-descriptionForeground); font-size:.88em; white-space:normal; }
.workflow-hint { margin-top:3px; color:var(--vscode-descriptionForeground); font-size:.78em; white-space:normal; }
.workflow { display:flex; flex-wrap:wrap; gap:5px; justify-content:flex-end; align-items:center; }
.workflow-separator { width:1px; height:24px; background:var(--row-border); margin:0 3px; }
.filterbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:7px 10px 9px; background:var(--vscode-sideBar-background); border-top:1px solid color-mix(in srgb, var(--row-border) 55%, transparent); }
.filterbar .grow { flex:1; min-width:250px; }
.quick-filters { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
.pager { display:flex; flex-wrap:wrap; gap:5px; align-items:center; margin-left:auto; }
.pager select { min-width:68px; }
.pager button { min-width:30px; padding-left:7px; padding-right:7px; }
.page-info { min-width:88px; text-align:center; color:var(--vscode-descriptionForeground); font-size:.86em; font-variant-numeric:tabular-nums; white-space:nowrap; }
input, textarea, select, button { font:inherit; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--row-border)); border-radius:2px; }
input, select { padding:4px 6px; }
textarea { width:100%; min-height:68px; resize:vertical; padding:5px 6px; line-height:1.35; }
button { cursor:pointer; padding:5px 8px; color:var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background:var(--vscode-button-secondaryBackground, var(--vscode-input-background)); border-color:var(--vscode-button-border, var(--row-border)); }
button:hover:not(:disabled) { background:var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
button:disabled { opacity:.45; cursor:default; }
button.primary-action { color:var(--vscode-button-foreground); background:var(--vscode-button-background); border-color:var(--vscode-button-background); font-weight:600; }
button.primary-action:hover:not(:disabled) { background:var(--vscode-button-hoverBackground); }
button.icon-only { min-width:31px; padding-left:7px; padding-right:7px; font-weight:600; }
.toggle { display:flex; align-items:center; gap:4px; white-space:nowrap; color:var(--vscode-descriptionForeground); padding:3px 6px; border:1px solid transparent; border-radius:3px; }
.toggle:hover { background:var(--vscode-list-hoverBackground); }
.banner { display:none; margin:8px 10px; padding:8px 10px; border:1px solid var(--vscode-inputValidation-warningBorder); background:var(--vscode-inputValidation-warningBackground); white-space:pre-wrap; }
.error { border-color:var(--vscode-inputValidation-errorBorder); background:var(--vscode-inputValidation-errorBackground); }
table { width:100%; border-collapse:collapse; table-layout:fixed; }
thead { position:sticky; top:var(--chrome-height); z-index:5; background:var(--vscode-editor-background); box-shadow:0 1px 0 var(--row-border); }
th { vertical-align:bottom; border-bottom:1px solid var(--row-border); padding:6px; background:var(--vscode-editor-background); }
.sort { width:100%; border:0; background:transparent; color:var(--vscode-foreground); text-align:left; padding:2px 0 5px; font-weight:600; }
th input { width:100%; min-width:0; }
td { vertical-align:top; border-bottom:1px solid var(--row-border); padding:7px 6px; }
tbody tr:hover { background:var(--vscode-list-hoverBackground); }
tr.row-missing td:first-child { border-left:3px solid var(--vscode-editorWarning-foreground); }
tr.row-review td:first-child { border-left:3px solid var(--vscode-charts-blue); }
tr.row-error td:first-child { border-left:3px solid var(--vscode-editorError-foreground); }
tr.row-draft td:first-child { box-shadow:inset 3px 0 0 var(--vscode-descriptionForeground); }
.col-source { width:20%; }.col-translation { width:22%; }.col-transfer { width:46px; }.col-proposal { width:22%; }.col-status { width:12%; }.col-notes { width:15%; }.col-actions { width:9%; min-width:112px; }
.source-text { white-space:pre-wrap; word-break:break-word; font-weight:500; }
.unit-id { margin-top:5px; color:var(--vscode-descriptionForeground); font-size:.78em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.notes { white-space:pre-wrap; word-break:break-word; font-size:.9em; }
.note { margin-bottom:6px; }.note-from { color:var(--vscode-descriptionForeground); font-weight:600; }
.origin { display:inline-block; margin-top:4px; padding:1px 6px; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border-radius:9px; font-size:.78em; }
.status-stack { display:flex; flex-direction:column; gap:5px; }.status-select { width:100%; }
.status-text { word-break:break-word; }
.warn { color:var(--vscode-editorWarning-foreground); margin-top:4px; font-size:.82em; }
.placeholder-error { margin-top:4px; color:var(--vscode-editorError-foreground); font-weight:600; font-size:.82em; white-space:pre-wrap; }
.maxwidth { margin-top:4px; color:var(--vscode-descriptionForeground); font-size:.82em; }.maxwidth.exceeded { color:var(--vscode-editorError-foreground); font-weight:600; }
.field-actions { display:flex; gap:4px; align-items:center; margin-top:4px; min-height:25px; }
.field-actions button { padding:3px 6px; }
.draft-label { color:var(--vscode-descriptionForeground); font-size:.8em; margin-left:auto; }
.filter-caption { color:var(--vscode-descriptionForeground); font-size:.85em; align-self:center; }
.transfer-cell { vertical-align:middle; text-align:center; padding-left:3px; padding-right:3px; }
.transfer-button { width:34px; height:34px; padding:0; font-size:1.15em; font-weight:700; }
.actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; align-items:start; }
.actions button { min-width:0; padding:5px 5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.actions .wide { grid-column:1 / -1; }
.loading-overlay { position:fixed; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; background:color-mix(in srgb, var(--vscode-editor-background) 86%, transparent); backdrop-filter:blur(1px); }
.loading-card { width:min(520px, calc(100vw - 48px)); padding:18px 20px; border:1px solid var(--row-border); background:var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow:0 4px 18px rgba(0,0,0,.22); }
.loading-title { font-weight:600; margin-bottom:10px; }
.loading-track { height:5px; overflow:hidden; background:var(--vscode-progressBar-background); opacity:.3; }
.loading-bar { height:100%; width:0%; background:var(--vscode-progressBar-background); opacity:1; transition:width .12s linear; }
.loading-count { margin-top:8px; color:var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
.hidden { display:none !important; }
.readonly-row { opacity:.78; }
.translate-no { opacity:.62; }
.busy { outline:1px solid var(--vscode-progressBar-background); outline-offset:-1px; }
.saved-flash { outline:1px solid var(--vscode-testing-iconPassed); }
@media (max-width:1180px) {
  .mainbar { align-items:flex-start; }
  .workflow { max-width:62%; }
  .col-notes { width:13%; }.col-actions { width:11%; }
}
</style>
</head>
<body>
<div class="chrome" id="chrome">
  <div class="mainbar">
    <div class="identity">
      <div class="title">AL Xliff Studio — XLIFF Editor</div>
      <div class="meta" id="meta">Loading…</div>
      <div class="workflow-hint">⇄ Sync → ? Try Translation / AI → review staged drafts → ✓ Apply Drafts → translated</div>
    </div>
    <div class="workflow">
      <button id="sync" title="Synchronize translation units with the matching generated .g.xlf file and create/update the companion .lng translation memory. This never creates proposals.">⇄ Sync</button>
      <button id="tryGet" class="primary-action" title="Stage missing translations without changing the XLIFF. Developer comments and exact .lng matches become Translation drafts; fuzzy and AI matches become Proposal drafts.">? Try Translation</button>
      <button id="acceptVisible" title="Move all valid visible proposals into editable Translation drafts. Nothing is written to the XLIFF yet.">← Proposals to Drafts</button>
      <button id="saveDrafts" title="Write all staged Translation drafts and Proposal drafts to the XLIFF and set them to state=translated.">✓ Apply Drafts</button>
      <button id="discardDrafts" title="Discard all staged Translation drafts and Proposal drafts.">↶ Discard Drafts</button>
      <span class="workflow-separator"></span>
      <button id="refresh" class="icon-only" title="Refresh editor view">↻</button>
      <button id="openText" class="icon-only" title="Open raw XLIFF/XML">&lt;/&gt;</button>
    </div>
  </div>
  <div class="filterbar">
    <input class="grow" id="globalFilter" type="search" placeholder="Search source, translation, proposal, status, notes or id…">
    <div class="quick-filters" title="Quick filters are OR-combined: a row is shown when it matches any selected category.">
      <span class="filter-caption">Any:</span>
      <label class="toggle"><input id="missingOnly" type="checkbox"> Missing</label>
      <label class="toggle"><input id="reviewOnly" type="checkbox"> Review</label>
      <label class="toggle"><input id="proposalOnly" type="checkbox"> Proposals</label>
      <label class="toggle"><input id="draftOnly" type="checkbox"> Drafts</label>
      <label class="toggle"><input id="placeholderErrorsOnly" type="checkbox"> Placeholder errors</label>
    </div>
    <div class="pager" aria-label="Pagination">
      <span class="filter-caption">Page size:</span>
      <select id="pageSize" title="Entries per page">
        <option value="50">50</option>
        <option value="100" selected>100</option>
        <option value="200">200</option>
      </select>
      <button id="firstPage" class="icon-only" title="First page">«</button>
      <button id="prevPage" class="icon-only" title="Previous page">‹</button>
      <span class="page-info" id="pageInfo">1 / 1</span>
      <button id="nextPage" class="icon-only" title="Next page">›</button>
      <button id="lastPage" class="icon-only" title="Last page">»</button>
    </div>
    <button id="clearFilters" title="Clear all filters">Reset</button>
  </div>
</div>
<div class="banner error" id="error"></div>
<div class="banner" id="warning"></div>
<div class="loading-overlay hidden" id="loadingOverlay" role="status" aria-live="polite">
  <div class="loading-card">
    <div class="loading-title" id="loadingTitle">Loading XLIFF…</div>
    <div class="loading-track"><div class="loading-bar" id="loadingBar"></div></div>
    <div class="loading-count" id="loadingCount">0 / 0 units</div>
  </div>
</div>
<table>
<thead>
<tr>
  <th class="col-source"><button class="sort" data-sort="source">Source</button><input id="filter-source" placeholder="Filter source"></th>
  <th class="col-translation"><button class="sort" data-sort="translation">Translation</button><input id="filter-translation" placeholder="Filter translation"></th>
  <th class="col-transfer" title="Move proposal into Translation draft"></th>
  <th class="col-proposal"><button class="sort" data-sort="proposal">Proposed translation</button><input id="filter-proposal" placeholder="Filter proposal"></th>
  <th class="col-status"><button class="sort" data-sort="status">Status</button><input id="filter-status" placeholder="Filter status"></th>
  <th class="col-notes"><button class="sort" data-sort="notes">Notes</button><input id="filter-notes" placeholder="Filter notes"></th>
  <th class="col-actions">Actions</th>
</tr>
</thead>
<tbody id="rows"></tbody>
</table>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let model = { rows:[], sourceLanguage:'', targetLanguage:'', readOnly:false, generated:false, stats:{} };
let sortField = 'source';
let sortDirection = 1;
const busyAi = new Set();
const busyTry = new Set();
let tryAllBusy = false;
let syncBusy = false;
let activeLoadId = 0;
let renderGeneration = 0;
const persistedState = vscode.getState() || {};
let pageSize = [50,100,200].includes(Number(persistedState.pageSize)) ? Number(persistedState.pageSize) : 100;
let currentPage = Math.max(1, Number(persistedState.currentPage) || 1);
let lastPageState = null;
const RENDER_CHUNK_SIZE = 50;
const rowsElement = document.getElementById('rows');
const metaElement = document.getElementById('meta');
const errorElement = document.getElementById('error');
const warningElement = document.getElementById('warning');
const globalFilter = document.getElementById('globalFilter');
const filters = {
  source: document.getElementById('filter-source'),
  translation: document.getElementById('filter-translation'),
  proposal: document.getElementById('filter-proposal'),
  status: document.getElementById('filter-status'),
  notes: document.getElementById('filter-notes')
};
const missingOnly = document.getElementById('missingOnly');
const reviewOnly = document.getElementById('reviewOnly');
const proposalOnly = document.getElementById('proposalOnly');
const draftOnly = document.getElementById('draftOnly');
const placeholderErrorsOnly = document.getElementById('placeholderErrorsOnly');
const syncButton = document.getElementById('sync');
const tryGetButton = document.getElementById('tryGet');
const saveDraftsButton = document.getElementById('saveDrafts');
const discardDraftsButton = document.getElementById('discardDrafts');
const acceptVisibleButton = document.getElementById('acceptVisible');
const chromeElement = document.getElementById('chrome');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingTitle = document.getElementById('loadingTitle');
const loadingBar = document.getElementById('loadingBar');
const loadingCount = document.getElementById('loadingCount');
const pageSizeSelect = document.getElementById('pageSize');
const firstPageButton = document.getElementById('firstPage');
const prevPageButton = document.getElementById('prevPage');
const nextPageButton = document.getElementById('nextPage');
const lastPageButton = document.getElementById('lastPage');
const pageInfo = document.getElementById('pageInfo');
pageSizeSelect.value = String(pageSize);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(function(entries) {
    const height = entries[0] && entries[0].contentRect ? entries[0].contentRect.height : 118;
    document.documentElement.style.setProperty('--chrome-height', Math.ceil(height) + 'px');
  }).observe(chromeElement);
}

function setLoading(stage, current, total, visible, itemLabel) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCurrent = Math.min(safeTotal || Number(current) || 0, Math.max(0, Number(current) || 0));
  const percent = safeTotal > 0 ? Math.max(0, Math.min(100, Math.round((safeCurrent / safeTotal) * 100))) : 0;
  const label = itemLabel || 'units';
  loadingTitle.textContent = stage || 'Loading XLIFF';
  loadingCount.textContent = safeTotal > 0 ? (safeCurrent.toLocaleString() + ' / ' + safeTotal.toLocaleString() + ' ' + label) : 'Working…';
  loadingBar.style.width = percent + '%';
  loadingOverlay.classList.toggle('hidden', !visible);
}
function hideLoading() { loadingOverlay.classList.add('hidden'); }
function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function lower(value) { return String(value == null ? '' : value).toLocaleLowerCase(); }
function extractPlaceholders(value) { return (String(value == null ? '' : value).match(/%\\d+|#\\d+|\\\\[nrt]|\\{\\{?[^{}]+\\}?\\}/g) || []).sort(); }
function placeholderError(source, translation) {
  if (!String(translation == null ? '' : translation).length) return '';
  const expected = extractPlaceholders(source);
  const actual = extractPlaceholders(translation);
  if (!expected.length && !actual.length) return '';
  if (expected.length === actual.length && expected.every(function(value, index) { return value === actual[index]; })) return '';
  return 'Placeholder mismatch — expected: ' + (expected.length ? expected.join(', ') : '(none)') + '; translation: ' + (actual.length ? actual.join(', ') : '(none)');
}
function notesText(row) { return (row.notes || []).map(function(note) { return [note.from, note.text, note.annotates, note.priority].filter(Boolean).join(' '); }).join(' | '); }
function fieldValue(row, field) { if (field === 'notes') return notesText(row); return String(row[field] == null ? '' : row[field]); }
function rowKey(row) { return String(row.id || '') + '\u0000' + String(row.source || ''); }
function draftCount() { return model.rows.filter(function(row) { return row.translationDirty; }).length; }
function stagedCount() { return model.rows.filter(function(row) { return row.translationDirty || Boolean(row.proposal); }).length; }
function dirtyRows() { return model.rows.filter(function(row) { return row.translationDirty; }); }
function stagedRows() { return model.rows.filter(function(row) { return row.translationDirty || Boolean(row.proposal); }); }
function matches(row) {
  const global = lower(globalFilter.value);
  const combined = [row.source,row.translation,row.proposal,row.status,notesText(row),row.id,row.proposalOrigin].join(' ');
  if (global && !lower(combined).includes(global)) return false;
  for (const field of Object.keys(filters)) {
    const needle = lower(filters[field].value);
    if (needle && !lower(fieldValue(row, field)).includes(needle)) return false;
  }
  const quickFilters = [];
  if (missingOnly.checked) quickFilters.push(Boolean(row.missing));
  if (reviewOnly.checked) quickFilters.push(Boolean(row.review));
  if (proposalOnly.checked) quickFilters.push(Boolean(row.proposal));
  if (draftOnly.checked) quickFilters.push(Boolean(row.translationDirty || row.proposal));
  if (placeholderErrorsOnly.checked) quickFilters.push(Boolean(placeholderError(row.source, row.translation) || placeholderError(row.source, row.proposal)));
  if (quickFilters.length && !quickFilters.some(Boolean)) return false;
  return true;
}
function compareRows(a,b) {
  const av = fieldValue(a, sortField).toLocaleLowerCase();
  const bv = fieldValue(b, sortField).toLocaleLowerCase();
  const cmp = av.localeCompare(bv, undefined, { numeric:true, sensitivity:'base' });
  if (cmp) return cmp * sortDirection;
  return (a.ordinal - b.ordinal);
}
function statusOptions(row) {
  const values = ['translated','signed-off','final','needs-translation','needs-adaptation','needs-l10n','needs-review-translation','needs-review-adaptation','needs-review-l10n','new','__none__'];
  const current = row.status === 'missing' ? 'missing' : (row.rawState || '__none__');
  if (row.status === 'missing' && !values.includes('missing')) values.unshift('missing');
  return values.map(function(value) {
    const label = value === '__none__' ? '(no state)' : value;
    const selected = (value === current || (value === 'missing' && row.status === 'missing')) ? ' selected' : '';
    const disabled = value === 'missing' ? ' disabled' : '';
    return '<option value="' + esc(value) + '"' + selected + disabled + '>' + esc(label) + '</option>';
  }).join('');
}
function noteHtml(row) {
  if (!row.notes || !row.notes.length) return '<span class="meta">—</span>';
  return row.notes.map(function(note) {
    const from = note.from ? '<span class="note-from">' + esc(note.from) + ':</span> ' : '';
    return '<div class="note">' + from + esc(note.text) + '</div>';
  }).join('');
}
function rowClass(row) {
  const translationError = placeholderError(row.source, row.translation);
  const proposalError = placeholderError(row.source, row.proposal);
  return (model.readOnly ? ' readonly-row' : '') +
    (row.notTranslatable ? ' translate-no' : '') +
    ((busyAi.has(row.ordinal) || busyTry.has(row.ordinal)) ? ' busy' : '') +
    ((row.translationDirty || row.proposal) ? ' row-draft' : '') +
    (translationError || proposalError ? ' row-error' : (row.missing ? ' row-missing' : (row.review ? ' row-review' : '')));
}
function rowHtml(row) {
  const disabled = model.readOnly || row.notTranslatable;
  const busy = busyAi.has(row.ordinal);
  const trying = busyTry.has(row.ordinal);
  const translationErrorForRow = placeholderError(row.source, row.translation);
  const proposalErrorForRow = placeholderError(row.source, row.proposal);
  const origin = row.proposalOrigin ? '<span class="origin">' + esc(row.proposalOrigin) + '</span>' : '';
  const maxWidth = row.maxWidth == null ? '' : '<div data-role="maxwidth" data-ordinal="' + row.ordinal + '" class="maxwidth' + (row.maxWidthExceeded ? ' exceeded' : '') + '">' + row.translation.length + ' / ' + row.maxWidth + '</div>';
  const translationPlaceholderHtml = '<div data-role="translation-placeholder-error" data-ordinal="' + row.ordinal + '" class="placeholder-error' + (translationErrorForRow ? '' : ' hidden') + '">' + esc(translationErrorForRow) + '</div>';
  const proposalPlaceholderHtml = '<div data-role="proposal-placeholder-error" data-ordinal="' + row.ordinal + '" class="placeholder-error' + (proposalErrorForRow ? '' : ' hidden') + '">' + esc(proposalErrorForRow) + '</div>';
  const statusDisabled = disabled || row.translationDirty || Boolean(row.proposal) ? ' disabled' : '';
  const status = disabled
    ? '<div class="status-text">' + esc(row.notTranslatable ? 'translate=no' : row.status) + '</div>'
    : '<div class="status-stack"><select class="status-select" data-action="status" data-ordinal="' + row.ordinal + '"' + statusDisabled + '>' + statusOptions(row) + '</select>' +
      (row.canConfirmReview ? '<button data-action="confirmReview" data-ordinal="' + row.ordinal + '" title="Confirm review and set state to translated"' + ((translationErrorForRow || row.translationDirty || row.proposal) ? ' disabled' : '') + '>✓ Review</button>' : '') + '</div>';
  const saveHidden = row.translationDirty ? '' : ' hidden';
  const acceptDisabled = disabled || !row.proposal || proposalErrorForRow || row.translationDirty || trying || tryAllBusy;
  return '<tr class="' + rowClass(row) + '" data-ordinal="' + row.ordinal + '">' +
    '<td><div class="source-text">' + esc(row.source) + '</div><div class="unit-id" title="' + esc(row.id) + '">' + esc(row.id) + '</div></td>' +
    '<td><textarea data-action="translation" data-ordinal="' + row.ordinal + '"' + (disabled ? ' disabled' : '') + '>' + esc(row.translation) + '</textarea>' + maxWidth + translationPlaceholderHtml +
      '<div class="field-actions"><button data-action="revertTranslation" data-ordinal="' + row.ordinal + '" class="' + saveHidden + '" title="Discard this Translation draft">↶</button>' +
      '<span data-role="draft-label" data-ordinal="' + row.ordinal + '" class="draft-label' + saveHidden + '">staged draft</span></div></td>' +
    '<td class="transfer-cell"><button class="transfer-button" data-action="accept" data-ordinal="' + row.ordinal + '" title="Move proposal into Translation draft; Apply Drafts writes it later"' + (acceptDisabled ? ' disabled' : '') + '>←</button></td>' +
    '<td><textarea data-action="proposal" data-ordinal="' + row.ordinal + '"' + (disabled ? ' disabled' : '') + '>' + esc(row.proposal) + '</textarea>' + origin + proposalPlaceholderHtml + '</td>' +
    '<td>' + status + (row.maxWidthExceeded ? '<div class="warn">maxwidth exceeded</div>' : '') + '</td>' +
    '<td class="notes">' + noteHtml(row) + '</td>' +
    '<td><div class="actions">' +
      '<button class="wide" data-action="try" data-ordinal="' + row.ordinal + '" title="Stage this row: Developer comment / exact .lng → Translation draft; fuzzy / AI → Proposal draft. Nothing is written yet."' + (disabled || !row.missing || row.translationDirty || row.proposal || trying || tryAllBusy ? ' disabled' : '') + '>' + (trying ? '…' : '? Try') + '</button>' +
      '<button data-action="ai" data-ordinal="' + row.ordinal + '" title="Create an AI Proposal draft only; nothing is written to the XLIFF"' + (disabled || row.translationDirty || row.proposal || busy || trying || tryAllBusy ? ' disabled' : '') + '>' + (busy ? '…' : 'AI') + '</button>' +
      '<button data-action="search" data-ordinal="' + row.ordinal + '" title="Search the exact English source in the project">⌕</button>' +
    '</div></td></tr>';
}
function updateSortLabels() {
  document.querySelectorAll('.sort').forEach(function(button) {
    const labels = {source:'Source',translation:'Translation',proposal:'Proposed translation',status:'Status',notes:'Notes'};
    button.textContent = labels[button.dataset.sort] + (sortField === button.dataset.sort ? (sortDirection > 0 ? ' ↑' : ' ↓') : '');
  });
}
function filteredSortedRows() {
  return model.rows.filter(matches).sort(compareRows);
}
function getPageState() {
  const visible = filteredSortedRows();
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  currentPage = Math.max(1, Math.min(currentPage, pageCount));
  const start = visible.length ? (currentPage - 1) * pageSize : 0;
  const end = Math.min(start + pageSize, visible.length);
  return { visible, pageCount, start, end, pageRows:visible.slice(start, end) };
}
function persistPageState() {
  vscode.setState({ pageSize:pageSize, currentPage:currentPage });
}
function updatePager(pageState) {
  const state = pageState || getPageState();
  pageSizeSelect.value = String(pageSize);
  pageInfo.textContent = state.visible.length ? (currentPage + ' / ' + state.pageCount) : '0 / 0';
  firstPageButton.disabled = currentPage <= 1 || !state.visible.length;
  prevPageButton.disabled = currentPage <= 1 || !state.visible.length;
  nextPageButton.disabled = currentPage >= state.pageCount || !state.visible.length;
  lastPageButton.disabled = currentPage >= state.pageCount || !state.visible.length;
  persistPageState();
}
function render(options) {
  const generation = ++renderGeneration;
  const stage = options && options.stage ? options.stage : 'Loading page';
  const showOverlay = !options || options.loading !== false;
  if (showOverlay) setLoading(stage, 0, 0, true, 'entries');

  // Let the overlay paint before filtering/sorting and page rendering starts.
  requestAnimationFrame(function() {
    if (generation !== renderGeneration) return;
    const state = getPageState();
    lastPageState = state;
    updatePager(state);
    rowsElement.innerHTML = '';
    updateSortLabels();
    updateSummary(state);

    if (!state.pageRows.length) {
      hideLoading();
      return;
    }

    if (showOverlay) setLoading('Rendering page ' + currentPage + ' / ' + state.pageCount, 0, state.pageRows.length, true, 'entries');
    let index = 0;
    function appendChunk() {
      if (generation !== renderGeneration) return;
      const end = Math.min(index + RENDER_CHUNK_SIZE, state.pageRows.length);
      rowsElement.insertAdjacentHTML('beforeend', state.pageRows.slice(index, end).map(rowHtml).join(''));
      index = end;
      if (showOverlay) setLoading('Rendering page ' + currentPage + ' / ' + state.pageCount, index, state.pageRows.length, true, 'entries');
      if (index < state.pageRows.length) {
        requestAnimationFrame(appendChunk);
        return;
      }
      updateSummary(state);
      hideLoading();
    }
    requestAnimationFrame(appendChunk);
  });
}

function updateSummary(pageState) {
  const state = pageState || lastPageState || getPageState();
  const visible = state.visible;
  const stats = model.stats || {};
  const drafts = draftCount();
  const staged = stagedCount();
  const proposals = model.rows.filter(function(row) { return Boolean(row.proposal); }).length;
  const placeholderErrorCount = model.rows.filter(function(row) { return placeholderError(row.source, row.translation) || placeholderError(row.source, row.proposal); }).length;
  const languageLabel = model.targetLanguage ? ((model.sourceLanguage || '?') + ' → ' + model.targetLanguage) : (model.sourceLanguage || 'XLIFF');
  const rangeLabel = visible.length ? ((state.start + 1) + '–' + state.end + ' of ' + visible.length + ' filtered') : '0 filtered';
  metaElement.textContent = languageLabel + ' · ' + rangeLabel + ' · ' + model.rows.length + ' total · page ' + (visible.length ? currentPage + ' / ' + state.pageCount : '0 / 0') + ' · missing ' + (stats.missing || 0) + ' · review ' + (stats.review || 0) + ' · proposals ' + proposals + ' · translation drafts ' + drafts + ' · staged ' + staged + ' · errors ' + placeholderErrorCount + (model.readOnly ? ' · read-only' : '');
  syncButton.disabled = model.readOnly || syncBusy || tryAllBusy || staged > 0;
  tryGetButton.textContent = tryAllBusy ? 'Trying…' : ('? Try Translation' + ((stats.missing || 0) ? ' (' + stats.missing + ')' : ''));
  tryGetButton.disabled = model.readOnly || syncBusy || tryAllBusy || staged > 0 || !(stats.missing || 0);
  saveDraftsButton.textContent = '✓ Apply Drafts' + (staged ? ' (' + staged + ')' : '');
  saveDraftsButton.disabled = model.readOnly || staged === 0;
  discardDraftsButton.disabled = staged === 0;
  const acceptable = state.pageRows.some(function(row) { return row.proposal && !row.notTranslatable && !row.translationDirty && !placeholderError(row.source, row.proposal); });
  acceptVisibleButton.disabled = model.readOnly || tryAllBusy || !acceptable;
}
function showError(message) { errorElement.textContent = message || ''; errorElement.style.display = message ? 'block' : 'none'; }
function showWarning(messages) { const text = (messages || []).join(String.fromCharCode(10)); warningElement.textContent = text; warningElement.style.display = text ? 'block' : 'none'; }
function rowByOrdinal(ordinal) { return model.rows.find(function(row) { return row.ordinal === ordinal; }); }
function updateInlineValidation(row, kind, value) {
  const error = placeholderError(row.source, value);
  const errorElementForRow = rowsElement.querySelector('[data-role="' + kind + '-placeholder-error"][data-ordinal="' + row.ordinal + '"]');
  if (errorElementForRow) {
    errorElementForRow.textContent = error;
    errorElementForRow.classList.toggle('hidden', !error);
  }
  if (kind === 'translation') {
    const maxWidthElement = rowsElement.querySelector('[data-role="maxwidth"][data-ordinal="' + row.ordinal + '"]');
    if (maxWidthElement && row.maxWidth != null) {
      maxWidthElement.textContent = value.length + ' / ' + row.maxWidth;
      maxWidthElement.classList.toggle('exceeded', value.length > row.maxWidth);
    }
  }
}
function updateRowControls(row) {
  const dirty = Boolean(row.translationDirty);
  ['revertTranslation'].forEach(function(action) {
    const button = rowsElement.querySelector('button[data-action="' + action + '"][data-ordinal="' + row.ordinal + '"]');
    if (button) button.classList.toggle('hidden', !dirty);
  });
  const draftLabel = rowsElement.querySelector('[data-role="draft-label"][data-ordinal="' + row.ordinal + '"]');
  if (draftLabel) draftLabel.classList.toggle('hidden', !dirty);
  const statusSelect = rowsElement.querySelector('select[data-action="status"][data-ordinal="' + row.ordinal + '"]');
  if (statusSelect) statusSelect.disabled = dirty || Boolean(row.proposal) || model.readOnly || row.notTranslatable;
  const acceptButton = rowsElement.querySelector('button[data-action="accept"][data-ordinal="' + row.ordinal + '"]');
  if (acceptButton) acceptButton.disabled = model.readOnly || row.notTranslatable || dirty || !row.proposal || Boolean(placeholderError(row.source, row.proposal));
  const tryButton = rowsElement.querySelector('button[data-action="try"][data-ordinal="' + row.ordinal + '"]');
  if (tryButton) tryButton.disabled = model.readOnly || row.notTranslatable || dirty || Boolean(row.proposal) || !row.missing || tryAllBusy;
  const aiButton = rowsElement.querySelector('button[data-action="ai"][data-ordinal="' + row.ordinal + '"]');
  if (aiButton) aiButton.disabled = model.readOnly || row.notTranslatable || dirty || Boolean(row.proposal) || tryAllBusy;
  const reviewButton = rowsElement.querySelector('button[data-action="confirmReview"][data-ordinal="' + row.ordinal + '"]');
  if (reviewButton) reviewButton.disabled = dirty || Boolean(row.proposal) || Boolean(placeholderError(row.source, row.translation));
  const tr = rowsElement.querySelector('tr[data-ordinal="' + row.ordinal + '"]');
  if (tr) tr.className = rowClass(row);
  updateSummary();
}
function revertRowDraft(row) {
  row.translation = row.savedTranslation;
  row.translationDirty = false;
  row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
  const editor = rowsElement.querySelector('textarea[data-action="translation"][data-ordinal="' + row.ordinal + '"]');
  if (editor) editor.value = row.translation;
  updateInlineValidation(row, 'translation', row.translation);
  updateRowControls(row);
}
function ensureNoDrafts(actionName) {
  if (!stagedCount()) return true;
  showError('Apply or discard staged drafts before ' + actionName + '.');
  return false;
}

rowsElement.addEventListener('input', function(event) {
  const ordinal = Number(event.target.dataset.ordinal);
  if (!Number.isInteger(ordinal)) return;
  const row = rowByOrdinal(ordinal); if (!row) return;
  if (event.target.dataset.action === 'translation') {
    row.translation = event.target.value;
    row.translationDirty = row.translation !== row.savedTranslation;
    row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
    updateInlineValidation(row, 'translation', row.translation);
    updateRowControls(row);
  } else if (event.target.dataset.action === 'proposal') {
    row.proposal = event.target.value;
    row.proposalOrigin = 'Manual';
    updateInlineValidation(row, 'proposal', row.proposal);
    vscode.postMessage({ type:'proposalChanged', ordinal:ordinal, text:event.target.value });
    updateRowControls(row);
  }
});

rowsElement.addEventListener('change', function(event) {
  const ordinal = Number(event.target.dataset.ordinal);
  if (!Number.isInteger(ordinal)) return;
  if (event.target.dataset.action === 'status') {
    const row = rowByOrdinal(ordinal);
    if (row && row.translationDirty) {
      showError('Save or discard the translation draft before changing status.');
      event.target.value = row.rawState || '__none__';
      return;
    }
    vscode.postMessage({ type:'updateStatus', ordinal:ordinal, state:event.target.value });
  }
});

rowsElement.addEventListener('keydown', function(event) {
  const ordinal = Number(event.target.dataset.ordinal);
  if (!Number.isInteger(ordinal)) return;
  const row = rowByOrdinal(ordinal); if (!row) return;
  if (event.target.dataset.action === 'translation') {
    if (event.key === 'Escape' && row.translationDirty) {
      event.preventDefault();
      revertRowDraft(row);
    }
  } else if (event.target.dataset.action === 'proposal') {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && row.proposal && !row.translationDirty && !placeholderError(row.source, row.proposal)) {
      event.preventDefault();
      vscode.postMessage({ type:'acceptProposal', ordinal:ordinal, translation:row.proposal });
    }
  }
});

rowsElement.addEventListener('click', function(event) {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const ordinal = Number(button.dataset.ordinal); const row = rowByOrdinal(ordinal); if (!row) return;
  const action = button.dataset.action;
  if (action === 'try') vscode.postMessage({ type:'tryUnit', ordinal:ordinal });
  if (action === 'search') vscode.postMessage({ type:'searchSource', source:row.source });
  if (action === 'ai') vscode.postMessage({ type:'aiTranslate', ordinal:ordinal });
  if (action === 'accept') vscode.postMessage({ type:'acceptProposal', ordinal:ordinal, translation:row.proposal });
  if (action === 'confirmReview') vscode.postMessage({ type:'confirmReview', ordinal:ordinal });
  if (action === 'revertTranslation') revertRowDraft(row);
});

document.querySelectorAll('.sort').forEach(function(button) {
  button.addEventListener('click', function() {
    const field = button.dataset.sort;
    if (sortField === field) sortDirection *= -1; else { sortField = field; sortDirection = 1; }
    currentPage = 1;
    render({ loading:true, stage:'Sorting entries' });
  });
});
[globalFilter, missingOnly, reviewOnly, proposalOnly, draftOnly, placeholderErrorsOnly].concat(Object.values(filters)).forEach(function(control) {
  control.addEventListener(control.type === 'checkbox' ? 'change' : 'input', function() {
    currentPage = 1;
    render({ loading:true, stage:'Filtering entries' });
  });
});
document.getElementById('clearFilters').addEventListener('click', function() {
  globalFilter.value = ''; missingOnly.checked = false; reviewOnly.checked = false; proposalOnly.checked = false; draftOnly.checked = false; placeholderErrorsOnly.checked = false;
  Object.values(filters).forEach(function(control) { control.value = ''; });
  currentPage = 1;
  render({ loading:true, stage:'Resetting filters' });
});
pageSizeSelect.addEventListener('change', function() {
  const requested = Number(pageSizeSelect.value);
  pageSize = [50,100,200].includes(requested) ? requested : 100;
  currentPage = 1;
  render({ loading:true, stage:'Loading page' });
});
firstPageButton.addEventListener('click', function() {
  if (currentPage === 1) return;
  currentPage = 1;
  render({ loading:true, stage:'Loading first page' });
});
prevPageButton.addEventListener('click', function() {
  if (currentPage <= 1) return;
  currentPage--;
  render({ loading:true, stage:'Loading previous page' });
});
nextPageButton.addEventListener('click', function() {
  const state = getPageState();
  if (currentPage >= state.pageCount) return;
  currentPage++;
  render({ loading:true, stage:'Loading next page' });
});
lastPageButton.addEventListener('click', function() {
  const state = getPageState();
  if (currentPage >= state.pageCount) return;
  currentPage = state.pageCount;
  render({ loading:true, stage:'Loading last page' });
});
syncButton.addEventListener('click', function() {
  if (!ensureNoDrafts('synchronizing')) return;
  vscode.postMessage({ type:'synchronizeFile' });
});
tryGetButton.addEventListener('click', function() {
  if (!ensureNoDrafts('trying translations')) return;
  vscode.postMessage({ type:'tryFile' });
});
saveDraftsButton.addEventListener('click', function() {
  const items = stagedRows().map(function(row) {
    return { ordinal:row.ordinal, translation:row.translationDirty ? row.translation : row.proposal };
  });
  if (items.length) vscode.postMessage({ type:'saveManyDrafts', items:items });
});
discardDraftsButton.addEventListener('click', function() {
  const proposalOrdinals = model.rows.filter(function(row) { return Boolean(row.proposal); }).map(function(row) { return row.ordinal; });
  dirtyRows().forEach(revertRowDraft);
  model.rows.forEach(function(row) { row.proposal = ''; row.proposalOrigin = ''; });
  if (proposalOrdinals.length) vscode.postMessage({ type:'clearProposals', ordinals:proposalOrdinals });
  render();
});
document.getElementById('refresh').addEventListener('click', function() { vscode.postMessage({ type:'refresh' }); });
document.getElementById('openText').addEventListener('click', function() {
  if (!ensureNoDrafts('opening the raw XML editor')) return;
  vscode.postMessage({ type:'openText' });
});
acceptVisibleButton.addEventListener('click', function() {
  const items = getPageState().pageRows.filter(function(row) {
    return row.proposal && !row.notTranslatable && !row.translationDirty && !placeholderError(row.source, row.proposal);
  }).map(function(row) { return { ordinal:row.ordinal, translation:row.proposal }; });
  if (items.length) vscode.postMessage({ type:'acceptMany', items:items });
});
window.addEventListener('message', function(event) {
  const message = event.data;
  if (message.type === 'loadStart') {
    const incomingLoadId = Number(message.loadId) || 0;
    if (activeLoadId && incomingLoadId && incomingLoadId < activeLoadId) return;
    activeLoadId = incomingLoadId;
    setLoading(message.stage || 'Loading XLIFF', message.current || 0, message.total || 0, true);
  } else if (message.type === 'loadProgress') {
    if (activeLoadId && Number(message.loadId) !== activeLoadId) return;
    setLoading(message.stage || 'Loading XLIFF', message.current || 0, message.total || 0, true);
  } else if (message.type === 'document') {
    const incomingLoadId = Number(message.loadId) || 0;
    if (activeLoadId && incomingLoadId && incomingLoadId < activeLoadId) return;
    if (incomingLoadId) activeLoadId = incomingLoadId;
    const drafts = new Map();
    (model.rows || []).forEach(function(row) {
      if (row.translationDirty) drafts.set(rowKey(row), { translation:row.translation, source:row.source });
    });
    message.rows.forEach(function(row) {
      row.savedTranslation = row.translation;
      row.translationDirty = false;
      const draft = drafts.get(rowKey(row));
      if (draft && draft.source === row.source) {
        row.translation = draft.translation;
        row.translationDirty = row.translation !== row.savedTranslation;
        row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
      }
    });
    model = message;
    showError('');
    showWarning(message.warnings || []);
    render({ loading:true, stage:'Loading page' });
  } else if (message.type === 'stageTranslationDrafts') {
    (message.items || []).forEach(function(item) {
      const row = rowByOrdinal(Number(item.ordinal));
      if (!row) return;
      row.translation = typeof item.translation === 'string' ? item.translation : row.translation;
      row.translationDirty = row.translation !== row.savedTranslation;
      row.proposal = '';
      row.proposalOrigin = '';
      row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
    });
    render();
  } else if (message.type === 'proposalAcceptedAsDraft') {
    const row = rowByOrdinal(Number(message.ordinal));
    if (row) {
      row.translation = typeof message.translation === 'string' ? message.translation : row.translation;
      row.translationDirty = row.translation !== row.savedTranslation;
      row.proposal = '';
      row.proposalOrigin = '';
      row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
      render();
    }
  } else if (message.type === 'proposalsAcceptedAsDrafts') {
    (message.items || []).forEach(function(item) {
      const row = rowByOrdinal(Number(item.ordinal));
      if (!row) return;
      row.translation = typeof item.translation === 'string' ? item.translation : row.translation;
      row.translationDirty = row.translation !== row.savedTranslation;
      row.proposal = '';
      row.proposalOrigin = '';
      row.maxWidthExceeded = row.maxWidth != null && row.translation.length > row.maxWidth;
    });
    render();
  } else if (message.type === 'error') {
    showError(message.message || 'XLIFF editor error.');
  } else if (message.type === 'aiBusy') {
    if (message.busy) busyAi.add(Number(message.ordinal)); else busyAi.delete(Number(message.ordinal));
    render({ loading:false });
  } else if (message.type === 'tryBusy') {
    if (message.all) tryAllBusy = Boolean(message.busy);
    else if (message.busy) busyTry.add(Number(message.ordinal));
    else busyTry.delete(Number(message.ordinal));
    render({ loading:false });
  } else if (message.type === 'syncBusy') {
    syncBusy = Boolean(message.busy);
    updateSummary();

  } else if (message.type === 'draftsSaved') {
    (message.items || []).forEach(function(item) {
      const row = rowByOrdinal(Number(item.ordinal));
      if (!row) return;
      row.savedTranslation = typeof item.translation === 'string' ? item.translation : row.savedTranslation;
      row.translation = row.savedTranslation;
      row.translationDirty = false;
      row.proposal = '';
      row.proposalOrigin = '';
      row.rawState = item.state || 'translated';
      row.status = item.state || 'translated';
      row.missing = false;
      row.review = false;
    });
    render();
  }
});
vscode.postMessage({ type:'ready' });
</script>
</body>
</html>`;

    }
}


function determineManualTranslationState(unit) {
    // Manual text editing must never change workflow state implicitly. Status is
    // changed only by an explicit status action or by accepting a proposal.
    return String(unit && unit.targetState || '');
}


function countTransUnitsFast(text) {
    const matches = String(text || '').match(/<trans-unit\b/gi);
    return matches ? matches.length : 0;
}

function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function getPlaceholderValidation(source, translation) {
    if (!String(translation == null ? '' : translation).length) {
        return { error: '', expected: extractPlaceholders(source), actual: [] };
    }
    const expected = extractPlaceholders(source);
    const actual = extractPlaceholders(translation);
    if (!expected.length && !actual.length) {
        return { error: '', expected, actual };
    }
    const matches = expected.length === actual.length && expected.every((value, index) => value === actual[index]);
    return {
        error: matches
            ? ''
            : `Placeholder mismatch — expected: ${expected.length ? expected.join(', ') : '(none)'}; translation: ${actual.length ? actual.join(', ') : '(none)'}`,
        expected,
        actual
    };
}

function displayStatus(unit) {
    if (String(unit.translate || '').trim().toLowerCase() === 'no') return 'translate=no';
    if (unit.targetState) return unit.targetState;
    if (unit.target === undefined || unit.target.length === 0) return 'missing';
    return 'no-state';
}


function isGeneratorFilename(uri) {
    return path.basename(uri.fsPath || uri.path || '').toLowerCase().endsWith('.g.xlf');
}

function isGeneratorXliff(uri, parsed) {
    return isGeneratorFilename(uri) || !parsed.targetLanguage;
}

function getMapUriForXlf(xlfUri, language) {
    const ext = path.extname(xlfUri.fsPath);
    let base = xlfUri.fsPath.slice(0, -ext.length);
    const localeSuffix = new RegExp(`\\.${escapeRegExp(language)}$`, 'i');
    if (!localeSuffix.test(base)) base += `.${language}`;
    return vscode.Uri.file(`${base}.lng`);
}

function createFindInFilesArgs(source) {
    return { query: source, triggerSearch: true, isRegex: false, matchWholeWord: false };
}

async function findSiblingGxlf(uri, targetLanguage) {
    const folder = path.dirname(uri.fsPath);
    if (targetLanguage) {
        const exactName = getGeneratorCompanionFilename(uri.fsPath, targetLanguage);
        if (exactName) {
            const exactUri = vscode.Uri.file(path.join(folder, exactName));
            try {
                await vscode.workspace.fs.stat(exactUri);
                return exactUri;
            } catch (_) {
                // Fall through to the unambiguous single-file fallback.
            }
        }
    }
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.g.xlf'));
    return found.length === 1 ? found[0] : undefined;
}

function normalizeLanguageCode(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

async function readText(uri) {
    const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (openDocument) return openDocument.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function writeText(uri, text) {
    const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (!openDocument) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        return;
    }
    if (openDocument.getText() === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
}

function isFileNotFound(err) {
    return err && (err.code === 'FileNotFound' || err.code === 'ENOENT');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(err) {
    return err instanceof Error ? err.message : String(err);
}

function mergeTranslationMemoryFromXliffTexts(existingEntries, xlfTexts) {
    let entries = Array.isArray(existingEntries) ? existingEntries.slice() : [];
    let pairCount = 0;
    let conflictCount = 0;

    for (const text of Array.isArray(xlfTexts) ? xlfTexts : []) {
        const parsed = parseXliff(String(text || ''));
        const pairs = translatedPairs(parsed, { treatNeedsTranslationAsMissing: true });
        const merged = mergeEntries(entries, pairs.entries, { overwrite: true });
        entries = merged.entries;
        pairCount += pairs.entries.length;
        conflictCount += pairs.conflicts.length + merged.conflicts.length;
    }

    return { entries, pairCount, conflictCount };
}

module.exports = {
    XliffEditorProvider,
    countTransUnitsFast,
    createFindInFilesArgs,
    getPlaceholderValidation,
    mergeTranslationMemoryFromXliffTexts,
    determineManualTranslationState,
    displayStatus,
    getMapUriForXlf,
    isGeneratorXliff
};
