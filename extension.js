'use strict';

const vscode = require('vscode');
const path = require('path');
const { parseLng, serializeLng, mergeEntries, entriesToMap } = require('./src/lng');
const {
    parseXliff,
    translatedPairs,
    isMissingTranslation,
    updateMissingTranslations,
    detectSourceChanges,
    flagSourceChangedUnits
} = require('./src/xliff');
const { translateItemsByKey, translateItemsByKeyDetailed, chooseAiModelCommand } = require('./src/ai');
const { LanguageMapEditorProvider } = require('./src/editor');
const { XliffEditorProvider } = require('./src/xlfEditor');
const { TranslationDashboard } = require('./src/dashboard');
const { AiUsagePage } = require('./src/aiUsagePage');
const { GlossaryEditorProvider, openProjectGlossary, readProjectGlossary } = require('./src/glossaryEditor');
const { resolveKnownTranslationForUnit } = require('./src/resolver');
const { createAiTranslationItem, getAiContextOptions } = require('./src/aiContext');
const { findDuplicateIds, findDuplicateGeneratorNotes, findMaxWidthViolations } = require('./src/validate');
const { mergeTranslationUnits, validateMergeLanguages } = require('./src/merge');
const { getGeneratorCompanionFilename } = require('./src/paths');
const { getLanguageMapUri, migrateLegacyLanguageMapIfNeeded, migrateWorkspaceLegacyLanguageMaps } = require('./src/studioPaths');
const { BRAND_NAME, COMMAND_PREFIX, CONFIG_SECTION } = require('./src/identity');
const { provenanceFromResolved, provenanceFromAi, withAction } = require('./src/provenance');
const { registerAutomaticQualityChecks } = require('./src/autoQuality');
const { registerAlTranslationHover } = require('./src/alHover');
const { openAiDebugLog } = require('./src/aiDebug');
const { openPerformanceDebugLog } = require('./src/performanceDebug');
const { registerActivityBar } = require('./src/activityBar');
const { registerQualityDiagnosticNavigation } = require('./src/qualityDiagnosticNavigation');
const { configureDocumentSessionCache, invalidateDocumentSession } = require('./src/documentSession');
const { invalidateQualityAnalysis } = require('./src/qualityCoordinator');

function applyDocumentSessionCacheConfiguration() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const cacheMb = Number(config.get('performance.documentSessionCacheMB', 384));
    const safeMb = Number.isFinite(cacheMb) ? Math.max(64, Math.min(2048, cacheMb)) : 384;
    configureDocumentSessionCache({ maxBytes: Math.trunc(safeMb * 1024 * 1024) });
}

function activate(context) {
    applyDocumentSessionCacheConfiguration();
    // Cancellation is independent of automatic QA and of an open custom editor.
    const cancelDocument = document => {
        if (!document || !/\.xlf$/i.test(document.uri.fsPath || '')) return;
        invalidateQualityAnalysis(document.uri);
        invalidateDocumentSession(document.uri);
    };
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.contentChanges && event.contentChanges.length) cancelDocument(event.document);
        }),
        vscode.workspace.onDidCloseTextDocument(cancelDocument),
        { dispose() { invalidateQualityAnalysis(); invalidateDocumentSession(); } }
    );
    context.subscriptions.push(
        LanguageMapEditorProvider.register(context),
        XliffEditorProvider.register(context),
        GlossaryEditorProvider.register(context),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.buildMaps`, () => buildMaps()),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.fillMissing`, () => fillMissingTranslations()),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.fillMissingCurrent`, uri => fillMissingTranslations(uri)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.selectAiModel`, () => chooseAiModelCommand()),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.mergeTranslations`, () => mergeTranslations()),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.openXliffEditor`, uri => openXliffEditor(uri)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.openDashboard`, () => TranslationDashboard.createOrShow(context)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.openAiUsage`, () => AiUsagePage.createOrShow(context)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.openAiDebugLog`, uri => openAiDebugLog(uri)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.openPerformanceDebugLog`, uri => openPerformanceDebugLog(uri)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.validateCurrent`, uri => validateCurrentXliff(uri)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.openGlossary`, uri => openProjectGlossary(uri)),
        vscode.commands.registerCommand(`${COMMAND_PREFIX}.openTranslationUnit`, arg => openTranslationUnitFromHover(arg))
    );
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event && typeof event.affectsConfiguration === 'function' && event.affectsConfiguration(`${CONFIG_SECTION}.performance.documentSessionCacheMB`)) {
            applyDocumentSessionCacheConfiguration();
        }
    }));
    registerQualityDiagnosticNavigation(context, (uri, target) => XliffEditorProvider.openAtDiagnosticTarget(uri, target));
    const qualityManager = registerAutomaticQualityChecks(context);
    registerActivityBar(context, {
        qualityManager,
        syncAll: async () => {
            const dashboard = TranslationDashboard.createOrShow(context);
            await dashboard.synchronizeAll();
        }
    });
    registerAlTranslationHover(context);
    // Upgrade legacy companion maps in the background so Translations/ can remain
    // XLIFF-only. Conflicting old/new maps are deliberately left untouched.
    void migrateWorkspaceLegacyLanguageMaps().catch(() => undefined);
}

async function openTranslationUnitFromHover(arg) {
    const value = arg && typeof arg === 'object' ? arg : {};
    let uri;
    try {
        uri = value.uri ? vscode.Uri.parse(String(value.uri)) : undefined;
    } catch (_) {
        uri = undefined;
    }
    if (!uri || !uri.fsPath || !uri.fsPath.toLowerCase().endsWith('.xlf')) {
        vscode.window.showWarningMessage(`${BRAND_NAME}: XLIFF target from hover is no longer available.`);
        return;
    }
    await XliffEditorProvider.openAtUnit(uri, String(value.unitId || ''), String(value.source || ''));
}



async function validateCurrentXliff(uri) {
    let target = uri;
    if (!target || !target.fsPath) {
        const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (active && active.uri && active.uri.fsPath.toLowerCase().endsWith('.xlf')) target = active.uri;
    }
    if (!target || !target.fsPath || !target.fsPath.toLowerCase().endsWith('.xlf')) {
        vscode.window.showInformationMessage(`${BRAND_NAME}: select an XLIFF file first.`);
        return;
    }
    await XliffEditorProvider.openWithQuality(target);
}

async function openXliffEditor(uri) {
    let target = uri;
    if (!target || !target.fsPath) {
        const active = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
        if (active && active.uri && active.uri.fsPath.toLowerCase().endsWith('.xlf')) target = active.uri;
    }
    if (!target || !target.fsPath || !target.fsPath.toLowerCase().endsWith('.xlf')) {
        vscode.window.showInformationMessage(`${BRAND_NAME}: select an XLIFF file first.`);
        return;
    }
    await vscode.commands.executeCommand('vscode.openWith', target, XliffEditorProvider.viewType);
}

async function findTranslationFiles(singleUri) {
    if (singleUri && singleUri.fsPath && singleUri.fsPath.toLowerCase().endsWith('.xlf')) {
        if (singleUri.fsPath.toLowerCase().endsWith('.g.xlf')) return [];
        return [singleUri];
    }
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const include = config.get('xliffGlob', '**/Translations/*.xlf');
    const exclude = config.get('excludeGlob', '**/*.g.xlf');
    return vscode.workspace.findFiles(include, exclude);
}

async function buildMaps(singleUri) {
    const files = await findTranslationFiles(singleUri);
    if (!files.length) {
        vscode.window.showInformationMessage('AL Xliff Studio: no translation XLIFF files found.');
        return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const checkDuplicateIds = config.get('validation.checkDuplicateIds', true);
    const checkDuplicateGeneratorNotes = config.get('validation.checkDuplicateGeneratorNotes', true);

    let createdOrUpdated = 0;
    let pairCount = 0;
    let conflictCount = 0;
    const skippedFiles = [];
    const failedFiles = [];

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'AL Xliff Studio: building language maps',
        cancellable: true
    }, async (progress, token) => {
        for (let i = 0; i < files.length; i++) {
            if (token.isCancellationRequested) break;
            const uri = files[i];
            progress.report({ message: path.basename(uri.fsPath), increment: 100 / files.length });
            try {
                const xlfText = await readText(uri);
                const parsed = parseXliff(xlfText);
                const language = parsed.targetLanguage || inferLanguageFromFilename(uri.fsPath);
                if (!language) continue;

                if (hasStructuralViolations(parsed, uri, skippedFiles, { checkDuplicateIds, checkDuplicateGeneratorNotes })) continue;

                const pairs = translatedPairs(parsed, { treatNeedsTranslationAsMissing: true });
                const mapUri = await getMapUri(uri, language);
                const existing = await readLngIfExists(mapUri);
                const merged = mergeEntries(existing.entries, pairs.entries, { overwrite: true });
                await writeText(mapUri, serializeLng(merged.entries, language));
                createdOrUpdated++;
                pairCount += pairs.entries.length;
                conflictCount += pairs.conflicts.length + merged.conflicts.length;
            } catch (err) {
                failedFiles.push({ uri, message: formatWriteError(err) });
            }
        }
    });

    const suffix = conflictCount ? ` ${conflictCount} conflicting duplicate source value(s) were detected.` : '';
    vscode.window.showInformationMessage(`AL Xliff Studio: ${createdOrUpdated} map file(s) updated from ${pairCount} translated source pair(s).${suffix}`);
    reportSkippedAndFailed(skippedFiles, failedFiles);
}


async function fillMissingTranslations(singleUri) {
    const files = await findTranslationFiles(singleUri);
    if (!files.length) {
        vscode.window.showInformationMessage('AL Xliff Studio: no translation XLIFF files found.');
        return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const treatNeedsTranslationAsMissing = config.get('treatNeedsTranslationAsMissing', true);
    const setTranslatedState = config.get('setTranslatedState', true);
    const checkDuplicateIds = config.get('validation.checkDuplicateIds', true);
    const checkDuplicateGeneratorNotes = config.get('validation.checkDuplicateGeneratorNotes', true);
    const checkMaxWidth = config.get('validation.checkMaxWidth', true);
    const sourceChangeEnabled = config.get('sourceChangeDetection.enabled', true);
    const provenanceEnabled = config.get('provenance.enabled', true) !== false;
    const fuzzyOptions = {
        enabled: config.get('fuzzyMatch.enabled', false),
        minimumQuality: config.get('fuzzyMatch.minimumQuality', 80)
    };

    let mapHits = 0;
    let commentHits = 0;
    let fuzzyHits = 0;
    let glossaryHits = 0;
    let aiHits = 0;
    let stillMissing = 0;
    let maxWidthViolationCount = 0;
    let sourceSynchronizedCount = 0;
    let sourceChangedTargetCount = 0;
    const changedFileKeys = new Set();
    const commentConflictKeys = new Set();
    const mapConflictKeys = new Set();
    const skippedFiles = [];
    const failedFiles = [];
    const workItems = [];

    // Phase 1 is strictly deterministic and is completed before AI is even
    // considered: Developer comment -> companion .lng -> exact project glossary. These translations are
    // written first. Only the trans-units that are still missing afterwards
    // are allowed to contribute to the AI prompt/count.
    const deterministicCancelled = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'AL Xliff Studio: applying local translation sources',
        cancellable: true
    }, async (progress, token) => {
        for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
            if (token.isCancellationRequested) return true;
            const uri = files[fileIndex];
            progress.report({ message: path.basename(uri.fsPath), increment: 100 / files.length });

            let originalText;
            let parsed;
            try {
                originalText = await readText(uri);
                parsed = parseXliff(originalText);
            } catch (err) {
                failedFiles.push({ uri, message: formatWriteError(err) });
                continue;
            }
            const language = parsed.targetLanguage || inferLanguageFromFilename(uri.fsPath);
            if (!language) continue;

            if (hasStructuralViolations(parsed, uri, skippedFiles, { checkDuplicateIds, checkDuplicateGeneratorNotes })) continue;

            // Synchronize changed English source text from the matching .g.xlf
            // before any translation lookup. Existing target text is preserved
            // as needs-l10n; empty targets continue through the normal pipeline.
            if (sourceChangeEnabled) {
                try {
                    const siblingUri = await findSiblingGxlf(uri, language);
                    if (siblingUri) {
                        const sourceParsed = parseXliff(await readText(siblingUri));
                        const sourceDuplicateIds = findDuplicateIds(sourceParsed);
                        if (sourceDuplicateIds.length) {
                            throw new Error(`generator XLIFF contains duplicate trans-unit id(s): ${sourceDuplicateIds.join(', ')}`);
                        }
                        if (normalizeLanguageCode(sourceParsed.sourceLanguage) !== normalizeLanguageCode(parsed.sourceLanguage)) {
                            throw new Error(`generator source-language ${sourceParsed.sourceLanguage} does not match translation source-language ${parsed.sourceLanguage}`);
                        }
                        const changedUnits = detectSourceChanges(parsed, sourceParsed);
                        if (changedUnits.size) {
                            const synchronized = flagSourceChangedUnits(originalText, changedUnits);
                            if (synchronized.synchronizedCount > 0) {
                                originalText = synchronized.text;
                                parsed = parseXliff(originalText);
                                await writeText(uri, originalText);
                                changedFileKeys.add(uri.toString());
                                sourceSynchronizedCount += synchronized.synchronizedCount;
                                sourceChangedTargetCount += synchronized.flaggedCount;
                            }
                        }
                    }
                } catch (err) {
                    failedFiles.push({ uri, message: `source sync: ${formatWriteError(err)}` });
                }
            }

            const mapUri = await getMapUri(uri, language);
            const existingMap = await readLngIfExists(mapUri);
            const glossary = config.get('glossary.enabled', true) ? await readProjectGlossary(uri) : { entries: [] };
            const glossaryEntries = glossary.entries || [];

            // Keep the companion map current with already translated XLIFF
            // entries before using it as lookup memory in this same run.
            const currentPairs = translatedPairs(parsed, { treatNeedsTranslationAsMissing });
            const seeded = mergeEntries(existingMap.entries, currentPairs.entries, { overwrite: true });
            const companionMap = entriesToMap(seeded.entries);
            const missingUnits = parsed.units.filter(unit => isMissingTranslation(unit, treatNeedsTranslationAsMissing));

            const unitsBySource = groupUnitsBySource(missingUnits);
            const translationByOrdinal = new Map();
            const sourceCandidates = new Map();

            for (const [source, units] of unitsBySource) {
                for (const unit of units) {
                    // Fixed priority for this exact trans-unit:
                    // 1. Developer comment
                    // 2. companion .lng (exact match)
                    // 3. project terminology glossary (exact source-term match)
                    // 4. companion .lng (fuzzy/similarity match, opt-in, flagged for review)
                    // AI is intentionally not part of this phase.
                    const resolved = resolveKnownTranslationForUnit(unit, units, language, companionMap, fuzzyOptions, glossaryEntries);
                    if (resolved.commentConflict) {
                        commentConflictKeys.add(`${uri.toString()}\u0000${source}`);
                    }

                    if (!resolved.translation) continue;

                    if (resolved.source === 'fuzzy') {
                        translationByOrdinal.set(unit.ordinal, {
                            text: resolved.translation,
                            review: true,
                            note: `Fuzzy match (${resolved.quality}%) from "${resolved.matchedSource}". Please review.`,
                            provenance: provenanceEnabled ? withAction(provenanceFromResolved(resolved, 'proposal'), 'staged-for-review') : undefined
                        });
                        fuzzyHits++;
                        // Unconfirmed fuzzy matches must not pollute the .lng translation memory.
                        continue;
                    }

                    translationByOrdinal.set(unit.ordinal, {
                        text: resolved.translation,
                        provenance: provenanceEnabled ? withAction(provenanceFromResolved(resolved, 'draft'), 'applied') : undefined
                    });
                    addSourceCandidate(sourceCandidates, source, resolved.translation);
                    if (resolved.source === 'comment') commentHits++;
                    if (resolved.source === 'map') mapHits++;
                    if (resolved.source === 'glossary') glossaryHits++;
                }
            }

            // Write all deterministic XLIFF results before deciding whether AI
            // is necessary. This is what makes the later AI count a true
            // remainder instead of an estimate made before local lookup work.
            let deterministicText;
            let mapMerged;
            try {
                const deterministicUpdate = updateMissingTranslations(originalText, new Map(), {
                    treatNeedsTranslationAsMissing,
                    setTranslatedState,
                    translationByOrdinal
                });
                deterministicText = deterministicUpdate.text;
                if (deterministicUpdate.updatedCount > 0) {
                    await writeText(uri, deterministicText);
                    changedFileKeys.add(uri.toString());
                }

                const deterministicAdditions = collectUnambiguousMapAdditions(
                    sourceCandidates,
                    uri,
                    mapConflictKeys
                );
                mapMerged = mergeEntries(seeded.entries, deterministicAdditions, { overwrite: true });
                await writeText(mapUri, serializeLng(mapMerged.entries, language));
            } catch (err) {
                failedFiles.push({ uri, message: formatWriteError(err) });
                continue;
            }

            // Reparse the already-updated XLIFF and derive the AI work only
            // from what is *still* missing now. Comment/.lng hits can therefore
            // never appear in the AI confirmation count.
            const afterDeterministic = parseXliff(deterministicText);
            const remainingUnits = afterDeterministic.units.filter(unit =>
                isMissingTranslation(unit, treatNeedsTranslationAsMissing)
            );
            const aiContextOptions = getAiContextOptions(config);
            const aiCompanionMap = entriesToMap(mapMerged.entries);
            const aiItems = remainingUnits.map(unit =>
                createAiTranslationItem(unit, afterDeterministic, aiCompanionMap, glossaryEntries, aiContextOptions)
            );

            workItems.push({
                uri,
                currentText: deterministicText,
                parsed: afterDeterministic,
                language,
                mapUri,
                mapEntries: mapMerged.entries,
                aiItems,
                glossaryEntries
            });
        }
        return false;
    });

    if (deterministicCancelled) return;

    const aiPendingCount = workItems.reduce((sum, item) => sum + item.aiItems.length, 0);
    const aiEnabled = config.get('ai.enabled', true) !== false;
    let useAi = false;

    // The confirmation is deliberately lazy: it is shown only when the fixed
    // priority chain has actually reached AI for at least one remaining text.
    if (aiEnabled && aiPendingCount > 0) {
        const choice = await vscode.window.showWarningMessage(
            `${aiPendingCount} open translation${aiPendingCount === 1 ? '' : 's'}`,
            { modal: true },
            'Use AI',
            'Continue without AI'
        );
        useAi = choice === 'Use AI';
    }

    if (useAi) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AL Xliff Studio: translating with AI',
            cancellable: true
        }, async (progress, token) => {
            let aiCompleted = 0;
            progress.report({ message: `0 / ${aiPendingCount}` });

            for (const work of workItems) {
                if (token.isCancellationRequested) break;
                if (!work.aiItems.length) continue;

                try {
                    let fileAiCompleted = 0;
                    const aiDetailed = await translateItemsByKeyDetailed(
                        work.aiItems,
                        work.parsed.sourceLanguage,
                        work.language,
                        token,
                        completed => {
                            const delta = Math.max(0, completed - fileAiCompleted);
                            fileAiCompleted = completed;
                            aiCompleted += delta;
                            progress.report({
                                message: `${Math.min(aiCompleted, aiPendingCount)} / ${aiPendingCount}`,
                                increment: aiPendingCount > 0 ? (delta * 100) / aiPendingCount : 0
                            });
                        },
                        work.uri
                    );
                    const aiTranslations = aiDetailed.translations;
                    const aiProvenance = provenanceEnabled
                        ? withAction(provenanceFromAi(aiDetailed.model, 'proposal'), 'applied')
                        : undefined;

                    const aiTranslationByOrdinal = new Map();
                    const aiSourceCandidates = new Map();
                    for (const item of work.aiItems) {
                        const translation = aiTranslations.get(item.key);
                        if (!translation) continue;
                        const unit = work.parsed.units[item.ordinal];
                        if (!unit) continue;
                        aiTranslationByOrdinal.set(item.ordinal, { text: translation, provenance: aiProvenance });
                        addSourceCandidate(aiSourceCandidates, unit.source, translation);
                        aiHits++;
                    }

                    const aiUpdate = updateMissingTranslations(work.currentText, new Map(), {
                        treatNeedsTranslationAsMissing,
                        setTranslatedState,
                        translationByOrdinal: aiTranslationByOrdinal
                    });
                    if (aiUpdate.updatedCount > 0) {
                        work.currentText = aiUpdate.text;
                        await writeText(work.uri, work.currentText);
                        changedFileKeys.add(work.uri.toString());
                    }

                    const aiAdditions = collectUnambiguousMapAdditions(
                        aiSourceCandidates,
                        work.uri,
                        mapConflictKeys
                    );
                    if (aiAdditions.length) {
                        const mapMerged = mergeEntries(work.mapEntries, aiAdditions, { overwrite: true });
                        work.mapEntries = mapMerged.entries;
                        await writeText(work.mapUri, serializeLng(work.mapEntries, work.language));
                    }
                } catch (err) {
                    const choice = await vscode.window.showWarningMessage(
                        `AL Xliff Studio: AI fallback failed for ${path.basename(work.uri.fsPath)}: ${formatError(err)}`,
                        'Continue without AI',
                        'Cancel'
                    );
                    if (choice === 'Cancel') return;
                    // Stop additional AI work after a failure, while keeping all
                    // deterministic translations that were already written.
                    break;
                }
            }
        });
    }

    for (const work of workItems) {
        let finalText = work.currentText;
        let finalParsed = parseXliff(finalText);



        if (checkMaxWidth) {
            maxWidthViolationCount += findMaxWidthViolations(finalParsed).length;
        }

        stillMissing += finalParsed.units.filter(unit =>
            isMissingTranslation(unit, treatNeedsTranslationAsMissing)
        ).length;
    }

    const aiStatus = aiPendingCount > 0 && (!aiEnabled || !useAi) && aiHits === 0
        ? ' AI was not used.'
        : '';
    const commentConflictText = commentConflictKeys.size
        ? ` ${commentConflictKeys.size} source(s) had conflicting Developer comments; an exact trans-unit comment still took precedence where available.`
        : '';
    const mapConflictText = mapConflictKeys.size
        ? ` ${mapConflictKeys.size} source(s) had context-specific translations and were therefore not collapsed into a single .lng entry.`
        : '';
    const fuzzyText = fuzzyHits ? `, ${fuzzyHits} fuzzy-match translation(s) flagged for review` : '';
    const maxWidthText = maxWidthViolationCount ? ` ${maxWidthViolationCount} target(s) exceed their maxwidth.` : '';
    const sourceChangedText = sourceSynchronizedCount
        ? ` ${sourceSynchronizedCount} source text(s) synchronized from .g.xlf; ${sourceChangedTargetCount} existing target(s) flagged needs-l10n for review.`
        : '';

    vscode.window.showInformationMessage(
        `AL Xliff Studio: ${changedFileKeys.size} XLIFF file(s) changed; ${commentHits} Developer-comment translation(s), ${mapHits} translation-memory hit(s), ${glossaryHits} glossary hit(s)${fuzzyText}, ${aiHits} AI translation(s), ${stillMissing} trans-unit(s) still missing.${aiStatus}${commentConflictText}${mapConflictText}${maxWidthText}${sourceChangedText}`
    );
    reportSkippedAndFailed(skippedFiles, failedFiles);
}

async function findSiblingGxlf(uri, targetLanguage) {
    const folder = path.dirname(uri.fsPath);
    const filename = path.basename(uri.fsPath);
    const language = targetLanguage || inferLanguageFromFilename(uri.fsPath);

    if (language) {
        const exactName = getGeneratorCompanionFilename(uri.fsPath, language);
        if (exactName) {
            const exactUri = vscode.Uri.file(path.join(folder, exactName));
            try {
                await vscode.workspace.fs.stat(exactUri);
                return exactUri;
            } catch (_) {
                // Fall through only when the exact companion is not present.
            }
        }
    }

    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '*.g.xlf'));
    // A single generator file is an unambiguous fallback. With multiple files,
    // refusing to guess is safer than synchronizing against the wrong app.
    return found.length === 1 ? found[0] : undefined;
}

// Structural checks can be enabled independently. The affected file is skipped
// rather than partially modified when an enabled check finds ambiguity.
function hasStructuralViolations(parsed, uri, skippedFiles, options = {}) {
    const duplicateIds = options.checkDuplicateIds === false ? [] : findDuplicateIds(parsed);
    const duplicateNotes = options.checkDuplicateGeneratorNotes === false ? [] : findDuplicateGeneratorNotes(parsed);
    if (!duplicateIds.length && !duplicateNotes.length) return false;
    skippedFiles.push({ uri, duplicateIds, duplicateNotes });
    return true;
}

function formatWriteError(err) {
    const code = err && err.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return `${formatError(err)} (the file may be open or locked by another process)`;
    }
    return formatError(err);
}

function reportSkippedAndFailed(skippedFiles, failedFiles) {
    if (skippedFiles.length) {
        const details = skippedFiles.map(entry => {
            const reasons = [];
            if (entry.duplicateIds.length) reasons.push(`duplicate id(s): ${entry.duplicateIds.join(', ')}`);
            if (entry.duplicateNotes.length) reasons.push(`duplicate Xliff Generator note(s)`);
            return `${path.basename(entry.uri.fsPath)} (${reasons.join('; ')})`;
        });
        vscode.window.showWarningMessage(
            `AL Xliff Studio: ${skippedFiles.length} file(s) skipped due to structural issues: ${details.join(', ')}`
        );
    }
    if (failedFiles.length) {
        const details = failedFiles.map(entry => `${path.basename(entry.uri.fsPath)}: ${entry.message}`);
        vscode.window.showWarningMessage(
            `AL Xliff Studio: ${failedFiles.length} file(s) could not be read or written: ${details.join(', ')}`
        );
    }
}

async function mergeTranslations() {
    const files = await findTranslationFiles();
    if (files.length < 2) {
        vscode.window.showInformationMessage('AL Xliff Studio: need at least two translation XLIFF files to merge.');
        return;
    }

    const fromPick = await vscode.window.showQuickPick(
        files.map(uri => ({ label: path.basename(uri.fsPath), description: uri.fsPath, uri })),
        { placeHolder: 'Merge FROM which XLIFF file?' }
    );
    if (!fromPick) return;

    const toPick = await vscode.window.showQuickPick(
        files.filter(uri => uri.toString() !== fromPick.uri.toString())
            .map(uri => ({ label: path.basename(uri.fsPath), description: uri.fsPath, uri })),
        { placeHolder: 'Merge INTO which XLIFF file?' }
    );
    if (!toPick) return;

    try {
        const sourceText = await readText(fromPick.uri);
        const targetText = await readText(toPick.uri);
        const sourceParsed = parseXliff(sourceText);
        const targetParsed = parseXliff(targetText);
        const languageCheck = validateMergeLanguages(targetParsed, sourceParsed);
        if (!languageCheck.compatible) {
            vscode.window.showWarningMessage(`AL Xliff Studio: merge blocked. ${languageCheck.reason}`);
            return;
        }

        const modePick = await vscode.window.showQuickPick([
            { label: 'Untranslated', description: 'Fill missing/new/needs-translation targets only', mode: 'untranslated' },
            { label: 'Overwrite', description: 'Replace the target text of every matched trans-unit', mode: 'overwrite' },
            { label: 'Add', description: 'Insert whole trans-units that exist in the source file but not in the target file', mode: 'add' }
        ], { placeHolder: 'Merge mode' });
        if (!modePick) return;

        const mergeConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const result = mergeTranslationUnits(targetText, targetParsed, sourceParsed, modePick.mode, {
            provenanceEnabled: mergeConfig.get('provenance.enabled', true) !== false,
            sourceText
        });
        if (result.updatedCount === 0 && result.addedCount === 0) {
            vscode.window.showInformationMessage('AL Xliff Studio: nothing to merge.');
            return;
        }

        await writeText(toPick.uri, result.text);
        vscode.window.showInformationMessage(
            `AL Xliff Studio: merged into ${path.basename(toPick.uri.fsPath)}: ${result.updatedCount} trans-unit(s) updated, ${result.addedCount} trans-unit(s) added.`
        );
    } catch (err) {
        vscode.window.showErrorMessage(`AL Xliff Studio: merge failed: ${formatWriteError(err)}`);
    }
}

function groupUnitsBySource(units) {
    const result = new Map();
    for (const unit of units || []) {
        if (!result.has(unit.source)) result.set(unit.source, []);
        result.get(unit.source).push(unit);
    }
    return result;
}

function collectUnambiguousMapAdditions(sourceCandidates, uri, mapConflictKeys) {
    const additions = [];
    for (const [source, translations] of sourceCandidates) {
        if (translations.size === 1) {
            additions.push({ source, translation: [...translations][0] });
        } else if (translations.size > 1) {
            mapConflictKeys.add(`${uri.toString()}\u0000${source}`);
        }
    }
    return additions;
}

function addSourceCandidate(candidateMap, source, translation) {
    if (!source || !translation) return;
    if (!candidateMap.has(source)) candidateMap.set(source, new Set());
    candidateMap.get(source).add(translation);
}

async function getMapUri(xlfUri, language) {
    return await migrateLegacyLanguageMapIfNeeded(xlfUri, language) || await getLanguageMapUri(xlfUri, language);
}

function inferLanguageFromFilename(filePath) {
    const match = path.basename(filePath).match(/\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})+)\.xlf$/i);
    return match ? match[1] : undefined;
}

function inferLanguageFromLngFilename(filePath) {
    const match = path.basename(filePath).match(/\.([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})+)\.lng$/i);
    return match ? match[1] : undefined;
}

async function readLngIfExists(uri) {
    try {
        return parseLng(await readText(uri));
    } catch (err) {
        if (err && (err.code === 'FileNotFound' || err.code === 'ENOENT')) return { entries: [], errors: [] };
        return { entries: [], errors: [] };
    }
}

async function readText(uri) {
    const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (openDocument) return openDocument.getText();
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

async function writeText(uri, text) {
    const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
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

function normalizeLanguageCode(value) {
    return String(value || '').trim().replace(/_/g, '-').toLowerCase();
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(err) {
    if (err instanceof Error) return err.message;
    return String(err);
}

function deactivate() {}

module.exports = { activate, deactivate, getMapUri, inferLanguageFromFilename, inferLanguageFromLngFilename };
