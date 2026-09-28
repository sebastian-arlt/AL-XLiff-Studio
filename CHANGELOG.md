# Changelog

## 1.1.10

- Adds pagination to the visual XLIFF editor with selectable page sizes of **50**, **100**, or **200** entries. Only the current page is rendered into the webview DOM, which substantially reduces rendering work for large XLIFF files.
- Adds first/previous/next/last page controls and keeps the chosen page size/current page in VS Code webview state. Filter and sort changes intentionally return to page 1.
- Changes the editor summary to show the current entry range, filtered count, total XLIFF count, and page position.
- Shows the loading overlay whenever the editor has to read/prepare a new XLIFF state or recompute/render a page after paging, filtering, sorting, or page-size changes. Page rendering reports `rendered / page entries` progress.
- Keeps global Apply Drafts behavior across all staged rows, while **Proposals to Drafts** now affects only proposals on the currently visible page.
- Extends regression coverage for pagination controls, 50/100/200 page sizes, page slicing, loading-overlay behavior, and persisted page state.

## 1.1.9

- Adds a visible loading overlay for large XLIFF files so the visual editor no longer appears idle while thousands of translation units are prepared.
- Shows the current stage plus an explicit `loaded / total units` counter and progress bar while the extension prepares row data.
- Renders large XLIFF tables incrementally in UI chunks and updates the counter while rows are actually being added to the editor. This keeps the webview responsive enough to repaint progress between chunks.
- Small XLIFF files still open directly without the loading overlay. The large-file threshold is currently 500 translation units.
- Adds regression coverage for fast trans-unit counting, backend preparation progress messages, and chunked webview rendering.

## 1.1.8

- Makes the visual XLIFF editor fully transactional for translation work: **? Try Translation**, per-row **? Try**, and per-row **AI** now stage changes only and never modify the XLIFF immediately.
- Developer-comment and exact `.lng` hits become editable Translation drafts; fuzzy and AI results remain Proposal drafts.
- Changes the per-row **←** action and **← Proposals to Drafts** batch action to move proposals into Translation drafts without writing the XLIFF or changing status.
- Makes **✓ Apply Drafts** the single batch commit point for both Translation drafts and Proposal drafts. Valid non-empty staged values are written as `state="translated"` and then added to the companion `.lng`.
- Removes the per-row Translation commit action and Ctrl/Cmd+Enter commit path, so leaving or editing a field cannot accidentally persist a staged translation.
- **↶ Discard Drafts** now clears both Translation drafts and Proposal drafts. Sync, Try Translation, and raw-XML switching are blocked while any staged changes exist.
- Fixes the existing batch proposal action path so **Proposals to Drafts** and proposal clearing are handled before single-row ordinal validation.
- Updates the Drafts quick filter and row staging indicator to include both Translation and Proposal drafts.
- Adds regression coverage for non-destructive Try/AI staging, proposal-to-draft movement, and `Apply Drafts` as the only translation commit point.

## 1.1.7

- Changes the visual editor **⇄ Sync** to keep current translation units in the exact order of the matching generated `.g.xlf` instead of appending newly discovered units to the end.
- Existing translated/review targets stay attached to their `trans-unit` while the sequence is rebuilt in generator order.
- New units are created with `state="needs-translation"` at their generator position, so a missing unit between two existing units is inserted between them.
- Obsolete units remain non-destructively preserved, but are moved after all current generator units while retaining their own relative order.
- Because the editor button and other callers use the shared synchronization routine, the corrected ordering applies consistently to every internal sync path.
- Adds regression tests for generator-order synchronization and insertion of multiple missing units between existing translations.

## 1.1.6

- **⇄ Sync** in the visual XLIFF editor now creates or updates the companion `.lng` translation memory automatically.
- Sync preserves confirmed source/translation pairs from the pre-sync XLIFF before source text is rewritten, then merges confirmed pairs from the synchronized XLIFF as well. This keeps the old source text available as a fuzzy-match basis for **? Try Translation** after a source change.
- Review states such as `needs-l10n` are still excluded from `.lng`, so unconfirmed translations do not pollute translation memory.
- Changes the quick filters **Missing**, **Review**, **Proposals**, **Drafts**, and **Placeholder errors** from AND behavior to OR behavior. With multiple quick filters selected, a row is visible when it matches any selected category.
- Global search and per-column filters remain AND constraints around that OR-combined quick-filter group.
- Adds regression coverage for post-sync `.lng` creation/update, preservation of pre-sync fuzzy lookup entries, and OR-combined quick filters.

## 1.1.5

- Reworks the visual XLIFF editor around an explicit workflow: **⇄ Sync → ? Try Translation → ← Accept proposal → translated**.
- Adds **⇄ Sync** directly to the XLIFF editor. It synchronizes translation units against the matching `.g.xlf`, updates changed Source values, adds missing units, and flags preserved targets for review without generating proposals.
- Replaces the former Fill/Suggest behavior in the editor with **? Try Translation**. Developer-comment and exact companion `.lng` matches are trusted and written directly to Translation as `translated`; fuzzy matches become proposals; only still unresolved rows may ask for AI and AI results also become proposals.
- Adds the same **? Try** workflow per row. The row reaches AI only if Developer comment, exact `.lng`, and optional fuzzy matching did not resolve it.
- Makes Translation editing draft-based. Typing and leaving the field never changes the XLIFF and never changes the target status. **✓ Apply** / **✓ Apply Drafts** explicitly commit text while preserving the current state; **↶** discards the local draft.
- Keeps proposal acceptance explicit through the monochrome **←** button between Translation and Proposed translation. Accepting a valid proposal writes it to Translation, sets `state="translated"`, and updates the companion `.lng`.
- Keeps status changes explicit. The status selector and **✓ Review** action remain separate from ordinary text editing; completed states still require valid placeholders.
- Adds a compact workflow hint, a Drafts quick filter, clearer toolbar grouping, and monochrome text/symbol actions (`⇄`, `?`, `←`, `✓`, `↶`, `↻`, `⌕`) instead of colored icon assets.
- Blocks Sync/Try/XML switching while unapplied Translation drafts exist so local edits cannot be lost accidentally.
- Adds a dedicated synchronization module and regression coverage for synchronization, draft editing, no-blur-save behavior, and the new Try Translation routing.

## 1.1.4

- Stops automatic proposal generation when the visual XLIFF editor opens, refreshes, or receives external document changes such as **Synchronize Translation Units**.
- Keeps synchronization structurally focused: source/status/notes changes no longer trigger Developer-comment, `.lng`, or fuzzy proposal lookup.
- Adds an explicit per-row **Suggest** action that creates a non-AI proposal from Developer comment → companion `.lng` → optional fuzzy matching.
- Keeps **AI Proposal** explicitly AI-only and preserves manually/explicitly created proposals across ordinary refreshes while invalidating them when the source text changes.


## 1.1.3

- Reworks the visual XLIFF editor into a clearer two-level workspace: primary file actions on top, search/quick filters below, and stronger row-state highlighting for missing, review, and placeholder-error rows.
- Adds a prominent **Fill Missing** button to the XLIFF editor. It runs the same current-file translation pipeline as `BC XLIFF: Fill Missing Translations in Current File` and shows the current missing-count directly in the button.
- Adds a per-row **Fill** action that processes only that trans-unit using the same priority: Developer comment → companion `.lng` → optional fuzzy match → AI only if still unresolved.
- The row Fill action asks for AI permission only when that exact row reaches the AI fallback, and uses the standard bottom-right VS Code progress notification for the single AI translation.
- Row Fill performs source synchronization against the matching `.g.xlf` for that unit before translation lookup when source-change detection is enabled.
- Fuzzy row fills are written as `needs-review-translation` with a `BC.XliffMap` review note; confirmed comment/`.lng`/AI fills are written as `translated` and added to `.lng`.
- Improves action labels/tooltips, disables conflicting actions while a fill is running, and keeps the sticky table header aligned automatically with the resized editor toolbar.
- Adds row-border state cues and more compact status text (`source → target`, visible/total, missing, review, proposals, errors).
- Adds regression coverage for the whole-file Fill Missing control, per-row Fill workflow, redesigned editor structure, and fuzzy review-note insertion.

## 1.1.2

- Fixed direct editing of the Translation column in the visual XLIFF editor.
- Translation text now stays local while typing and is committed when the field changes/leaves focus instead of re-rendering the whole table on every edit.
- Placeholder mismatches no longer discard manual text; the translation is saved and marked `needs-review-translation` with the existing red validation message.
- Valid manual translations are saved as `translated` and added to the companion `.lng` translation memory.
- Reduced editor refreshes after webview-originated document edits to avoid cursor/focus loss.

## 1.1.1

- Adds a per-row **Review ✓** action for `needs-review-translation` targets. It changes the state to `translated` only when a non-empty translation exists and all placeholders match.
- Confirming a review through the new button writes the confirmed translation into the companion `.lng` translation memory when unambiguous.
- Adds inline red placeholder diagnostics to each XLIFF editor row. Mismatches show the placeholders expected from Source and the placeholders actually found in Translation.
- Applies the same placeholder diagnostics to Proposed translation and disables proposal acceptance while placeholders are inconsistent.
- Missing/empty translations are not treated as placeholder errors; validation starts once a translation/proposal contains text.
- Adds a **Placeholder errors only** quick filter and a placeholder-error count to the XLIFF editor status line.
- Prevents completed states (`translated`, `signed-off`, `final`) from being assigned to empty or placeholder-invalid targets; valid confirmed targets are added to `.lng`.
- Adds regression coverage for placeholder diagnostics, the review confirmation action, filter UI, and generated webview placeholder matching.

## 1.1.0

- Adds a full **BC XLIFF Editor** custom editor for `.xlf` files with Source, Translation, Proposed translation, Status, Notes, and row actions.
- Adds independent per-column filters plus global filtering and sortable Source/Translation/Proposal/Status/Notes columns. Sorting is visual only and never reorders XLIFF trans-units.
- Adds quick filters for missing translations, review-state targets, and rows with proposals.
- Reuses Developer-comment and companion `.lng` translations as non-destructive proposals in the editor; optional fuzzy matches include their quality/origin.
- Adds a per-row AI translation action that writes only to the proposal field until explicitly accepted.
- Adds editable manual proposals, per-row accept, and **Accept visible proposals** for filtered review workflows.
- Accepted proposals are marked `translated` and written into the companion `.lng` translation memory when unambiguous.
- Adds exact-source workspace search per row, matching the `.lng` editor search behavior.
- Makes generated `.g.xlf` / no-target-language XLIFF documents read-only in the visual editor and provides **Open XML** to switch to the standard text editor.
- Displays and protects `translate="no"` units; these are now also excluded from missing-translation processing.
- Adds inline `maxwidth` length/violation feedback and structural duplicate warnings.
- Adds direct target editing with placeholder validation and editable XLIFF target states.
- Adds **BC XLIFF: Open Visual XLIFF Editor** and Explorer/editor-title context-menu integration.
- Adds regression tests for the XLIFF webview, editor contribution, unit editing/status changes, and `translate="no"` protection.

## 1.0.11

- Fixes fuzzy-match handling: `needs-review-translation` is now a review state and is no longer counted as missing or sent to AI.
- Preserves `needs-adaptation`, `needs-l10n`, and `needs-review-*` targets for human review instead of automatically retranslating them.
- Excludes review-state targets from `.lng` translation memory so unconfirmed fuzzy/merge/source-change candidates cannot become trusted lookup entries.
- Moves source-change synchronization before translation lookup and copies the current `<source>` content from the matching `.g.xlf` into the translation XLIFF.
- Matches generator files by basename first (`MyApp.de-DE.xlf` → `MyApp.g.xlf`) and refuses to guess when multiple fallback `.g.xlf` files exist.
- Source-change handling is no longer blocked by unrelated `BC.XliffMap` fuzzy/merge notes; only the specific source-change note is idempotent.
- Existing usable targets whose source changed are preserved as `needs-l10n`; empty/new/`needs-translation` targets remain eligible for normal translation.
- Adds generator source-language and duplicate-id safety checks before source synchronization.
- Splits duplicate-id and duplicate-`Xliff Generator`-note validation into independent settings.
- Blocks XLIFF merge across different source/target languages and blocks structurally ambiguous merge files.
- `Untranslated` merge now fills empty/new/`needs-translation` targets but preserves review/adaptation/l10n targets.
- Makes merge review notes idempotent.
- Adds regression coverage for the corrected review-state, source-sync, generator matching, and merge behavior.

## 1.0.10

- Documents that the validation, fuzzy-match, source-change-detection, and merge features added in 1.0.9 were ported from [BC.SyncXlf](https://dev.azure.com/BE-terna-Development/_git/BC.SyncXlf), a Business Central XLIFF sync CLI originally created by Christoph Stuber (former BE-terna employee). Credit goes to that project for the original approach.

## 1.0.9

- Adds duplicate detection: files with duplicate trans-unit ids or duplicate `Xliff Generator` notes are skipped with a warning instead of being partially processed.
- Adds a `maxwidth` check that reports filled target texts exceeding their trans-unit's declared maximum width.
- Adds an opt-in fuzzy/similarity translation-memory match (Levenshtein-based) that fills a close `.lng` match and flags it `needs-review-translation`; fuzzy matches are never written back into `.lng`.
- Adds source-change detection: already-translated trans-units are compared by id against the sibling `*.g.xlf` file, and a changed source text is flagged `needs-l10n` with a review note.
- Adds the `BC XLIFF: Merge Translations Between Files` command with three modes (Untranslated/Overwrite/Add) to copy translations between two already-translated XLIFF files.
- Adds friendlier error reporting when an XLIFF or `.lng` file cannot be read or written (e.g. locked by another process).
- Adds regression coverage for all of the above.

## 1.0.8

- Adds a `Source = Translation` filter to the visual `.lng` editor; it can be combined with the existing text filter.
- Adds a magnifying-glass button to every map row that opens VS Code workspace search for the exact English source text.
- Shows visible/total row counts while editor filters are active.
- Adds regression coverage for the new editor controls and exact non-regex workspace-search arguments.

## 1.0.7

- Makes the translation pipeline strictly two-phase: first Developer comments and the companion `.lng` are applied and written, then the XLIFF is reparsed.
- Shows the AI confirmation only if translations are still missing after that deterministic phase.
- The AI confirmation count now contains only unique source texts that genuinely still require an AI request.
- Existing translated XLIFF pairs are merged into the companion `.lng` before local lookup in the same run, avoiding unnecessary AI fallback for already-known text.
- Declining or closing the AI confirmation keeps the already-applied comment/`.lng` translations intact.
- Adds regression coverage that verifies deterministic updates and reparsing happen before the AI prompt/count.

## 1.0.6

- Simplifies the AI confirmation dialog so it shows only the number of translations that still require AI.
- Shows live AI translation progress in the VS Code notification popup at the bottom right.
- Progress is based on the actual number of unique source texts sent to AI and advances after each AI batch.
- Adds regression coverage for AI progress callbacks and the simplified confirmation dialog.

## 1.0.5

- Fixes Developer-comment resolution for repeated English source texts by resolving the exact `trans-unit` before grouping/reuse.
- A direct `DEU=...`, `de-DE=...`, etc. note now wins for that unit even when another unit with the same source contains a different translation.
- Adds unit-specific XLIFF updates so identical source strings can receive different context-specific target texts.
- Prompts on every translation run before any VS Code AI request is made; users can continue using only Developer comments and `.lng` matches.
- Does not persist AI consent between runs.
- Adds regression coverage for the reported `Customer No.` / `DEU=Debitornummer` case and context-specific duplicate sources.

## 1.0.4

- Enforces a fixed translation priority: Developer comment → companion `.lng` → VS Code AI.
- Removes workspace-wide `.lng` lookup from the translation path.
- Uses only the `.lng` file associated with the XLIFF currently being processed.
- Conflicting Developer-comment translations now fall through to the companion `.lng`, then AI, instead of stopping translation entirely.
- Adds regression tests for the fixed resolver priority.

## 1.0.3

- Uses explicit translations from AL `Comment = ...` / XLIFF Developer notes before translation-memory fallback and AI.
- Supports both BCP-47 language keys such as `de-DE=...; en-US=...` and classic Business Central/NAV three-letter keys such as `DEU=...; ENU=...`.
- Adds a language-code lookup table for common BCP-47 ↔ classic NAV/Windows language identifiers.
- Ignores ordinary placeholder documentation such as `%1 = Customer No.; %2 = Posting Date`.
- Detects conflicting Developer-comment translations for the same source and leaves them unchanged instead of guessing.
- Adds regression tests for Developer-comment translation extraction and language aliases.

## 1.0.2

- Fixed XLIFF updates for self-closing targets such as `<target state="needs-translation"/>`.
- The stale self-closing target is now replaced by the translated target instead of leaving two target elements in the trans-unit.
- Added regression coverage for self-closing XLIFF targets.

## 1.0.1

- Fixed the BC Language Map Editor webview staying empty because an escaped newline became an invalid JavaScript string in the generated HTML.
- Added a regression test that syntax-checks the generated webview script.

## 1.0.0

- Create/update one `.<language>.lng` translation-memory file per non-generated XLIFF file.
- Deduplicate by English source text.
- Fill missing/stale XLIFF targets from companion/workspace language maps.
- Use VS Code Language Model API as fallback and persist AI translations in XLIFF and `.lng`.
- Add visual two-column `.lng` custom editor with search, add/delete and sorting.
- Reject AI translations that alter Business Central placeholders.
