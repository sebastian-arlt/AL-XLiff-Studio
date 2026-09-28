# BC XLIFF Language Map

### Visual XLIFF editing workflow

The visual editor uses an explicit staging workflow: **⇄ Sync → ? Try Translation / AI → review drafts → ✓ Apply Drafts → translated**. Try/AI actions and manual Translation edits do not modify the XLIFF immediately. All staged changes stay visible until **✓ Apply Drafts** writes them together as `translated`; leaving a field never saves or changes status.

The visual editor paginates XLIFF rows and renders only the current page. Page size can be set to **50**, **100**, or **200** entries. A loading overlay is shown whenever a new XLIFF state is read/prepared or a page must be recomputed after paging, filtering, sorting, or changing the page size; the overlay shows the current stage and `loaded / total` progress.

**⇄ Sync** also creates/updates the companion `.lng`. Confirmed translations from the pre-sync XLIFF are preserved first, so an old source remains available to fuzzy matching after the generator changes that source.

The quick category filters **Missing**, **Review**, **Proposals**, **Drafts**, and **Placeholder errors** are OR-combined. Global search and per-column filters still narrow the result in addition to that category selection.

## Installation

Install `bc-xliff-language-map-1.1.10.vsix` with **Extensions: Install from VSIX...** in the VS Code Command Palette. No npm dependencies are required at runtime.

VS Code extension for Microsoft Dynamics 365 Business Central AL projects. It keeps a translation-memory file next to each non-generated XLIFF translation file and can restore translations after XLIFF ids change.

## Main workflow

1. Run **BC XLIFF: Build/Update Language Maps**.
2. For every translation `.xlf` except `.g.xlf`, the extension creates/updates a companion file such as `MyApp.de-DE.lng`.
3. The `.lng` file contains one unique English source string and one translation per row.
4. After AL refactoring/regeneration changes XLIFF ids, run **BC XLIFF: Fill Missing Translations**.
5. Missing targets are resolved in this fixed order:
   - explicit translation from the unit's Developer comment,
   - companion `.lng` translation memory (exact source match; optional fuzzy match is part of this translation-memory step and is flagged `needs-review-translation`),
   - VS Code Language Model API when enabled.
   Review states such as `needs-review-translation`, `needs-adaptation`, and `needs-l10n` are preserved for human review and are not sent to AI.
6. If entries still need AI, the extension asks for permission on every translation run before sending any request. Successful AI translations are written both to the XLIFF and the companion `.lng` file.
7. Before translation lookup, the extension synchronizes changed `<source>` text from the matching sibling `.g.xlf` file by trans-unit id. Existing usable targets are preserved as `state="needs-l10n"` with a source-change review note; empty/new/`needs-translation` targets remain eligible for the normal translation pipeline.
8. Use **BC XLIFF: Merge Translations Between Files** to copy translations between two already-translated XLIFF files (e.g. from a similar app) without going through `.g.xlf`/comments/AI.

## `.lng` format

The raw file is deliberately simple and Git-friendly:

```text
# BC XLIFF Language Map v1
# Language: de-DE
"Encoding time"\t"Kodierungszeit"
"Invalid barcode."\t"Ungültiger Barcode."
```

Both values are JSON strings separated by a TAB. This safely preserves quotes, tabs and line breaks while still producing a true two-column text format.

## Visual editor

Files named `*.<language>.lng` open with **BC Language Map Editor**. The editor provides:

- two editable columns,
- search/filter across source and translation,
- a **Source = Translation** filter for suspicious/untranslated-looking entries,
- a per-row magnifying-glass button that opens VS Code workspace search for the exact English source text,
- add/delete,
- sorting,
- duplicate-source validation,
- normal VS Code save/undo behavior through a `CustomTextEditorProvider`.

Use **Reopen Editor With...** if you want to inspect the raw text instead.


## Visual XLIFF editor

Files ending in `.xlf` open with **BC XLIFF Editor**. Translation XLIFF files are editable; generated `.g.xlf` files (and XLIFF files without a `target-language`) are deliberately read-only. Use **</>** or **Reopen Editor With...** to inspect the raw XML.

The editor is designed around an explicit review workflow:

`⇄ Sync → ? Try Translation / AI → review staged drafts → ✓ Apply Drafts → translated`

### 1. Synchronize

**⇄ Sync** synchronizes the current translation XLIFF with the matching sibling `.g.xlf`. It updates changed Source values, adds generator trans-units that are missing from the translation file **at the same position/order as in the `.g.xlf`**, preserves obsolete translation units after the current generator units, and marks preserved targets for review when their Source changed. Existing translations stay attached to their trans-unit while all current units are reordered to match the generated base file. Synchronization is structural only: it never performs translation lookup and never creates proposals.

### 2. Try Translation

**? Try Translation** processes all currently missing targets. Each row also has a **? Try** button for the same workflow on only that trans-unit. Nothing is written to the XLIFF during this phase:

1. explicit Developer-comment translation → staged as an editable **Translation draft**;
2. exact companion `.lng` match → staged as an editable **Translation draft**;
3. optional fuzzy `.lng` match → staged in **Proposed translation** for review;
4. if still unresolved, the editor asks whether AI may be used; an AI result is staged in **Proposed translation**.

The whole-file AI question contains only the rows that genuinely reached the AI stage. Fuzzy proposals are not sent to AI. The per-row **AI** button is an explicit AI-only staging action and also never modifies the XLIFF by itself.

### 3. Review proposals and drafts

The narrow column between Translation and Proposed translation contains a monochrome **←** button. It moves a valid proposal into the editable **Translation draft** field and removes the proposal, but still does **not** change the XLIFF or status. **← Proposals to Drafts** performs the same staging move for all currently visible valid proposals.

Proposal text itself is editable. Placeholder mismatches are shown in red. A proposal may also remain in the Proposal column: **✓ Apply Drafts** can commit it directly without requiring the `←` move first.

### 4. Apply staged changes

Translation textareas are draft-based. Typing, tabbing away, clicking elsewhere, or leaving the field does **not** write to the XLIFF and does **not** alter the status. Try/AI results are staged in the same review session.

- **✓ Apply Drafts** is the single commit point for all staged Translation drafts and Proposal drafts. Every valid, non-empty staged translation is written to the XLIFF as `state="translated"` and added to the companion `.lng` translation memory.
- Rows with placeholder mismatches or empty staged values are skipped and remain visible for correction.
- **↶** discards one manual Translation draft; **↶ Discard Drafts** discards all staged Translation and Proposal drafts.
- `Escape` discards the current manual Translation draft. There is no per-row save/commit shortcut.
- The editor blocks Sync, Try Translation, and switching to raw XML while staged changes exist so a review set cannot be lost accidentally.

Status changes outside this staging workflow remain explicit. Rows with an already persisted `state="needs-review-translation"` additionally show **✓ Review**, which confirms a valid existing target as `translated`. Completed states (`translated`, `signed-off`, `final`) cannot be assigned to empty or placeholder-invalid persisted targets.

### Navigation, filtering and validation

The table shows **Source**, **Translation**, **Proposed translation**, **Status**, **Notes**, and actions. Every data column has its own contains-filter and sortable header. Sorting only changes the view and never reorders XLIFF trans-units. A global search covers Source, Translation, Proposal, Status, Notes, id and proposal origin. Quick filters are available for **Missing**, **Review**, **Proposals**, **Drafts**, and **Placeholder errors**. **Drafts** includes any staged Translation or Proposal change; the **Proposals** filter is the narrower subset for rows that still have a proposal.

Per row, **⌕** opens VS Code workspace search for the exact English Source. All workflow symbols are plain text and inherit the VS Code foreground color; no colored icon assets are used.

Large XLIFF files use pagination instead of rendering every trans-unit at once. Use the page-size selector for **50 / 100 / 200** entries and the `« ‹ page / pages › »` controls to move through the filtered/sorted result. The summary shows the current range (for example `101–200 of 437 filtered · 8,420 total`). Paging, filter/sort changes and document reloads show the loading overlay while the new page is prepared and rendered.

Additional safeguards:

- `translate="no"` units are visible but cannot be edited or sent to AI.
- Source/Translation and Source/Proposal placeholders (`%1`, `%2`, `#1`, escaped control sequences and brace placeholders) are compared. Mismatches are displayed in red per row.
- `maxwidth` is shown as `current length / maxwidth`; violations are highlighted.
- Duplicate trans-unit ids and duplicate `Xliff Generator` notes are surfaced as warnings.
- `.g.xlf` files are read-only in the visual editor.
- **↻** refreshes the view without generating proposals.


## Commands

- `BC XLIFF: Build/Update Language Maps`
- `BC XLIFF: Fill Missing Translations`
- `BC XLIFF: Fill Missing Translations in Current File`
- `BC XLIFF: Select Translation AI Model`
- `BC XLIFF: Merge Translations Between Files`
- `BC XLIFF: Open Visual XLIFF Editor`

## AI behavior

AI is only used from an explicit translation command and only after neither an explicit Developer-comment translation nor the companion `.lng` contains the source string. Developer-comment and companion `.lng` matches are first applied to the XLIFF. The updated XLIFF is then reparsed, and only if entries are still missing does a modal confirmation appear. It shows only the number of unique source texts that genuinely still require AI. Choosing **Continue without AI** leaves the already-applied comment/`.lng` translations in place and leaves only the remaining entries untouched. The permission is not persisted. While AI translation is running, the VS Code notification popup at the bottom right shows a progress bar and a `completed / total` counter that advances after each AI batch. The extension uses VS Code's Language Model API. The default vendor is `copilot`; you can choose an exact available model with the model-selection command.

The prompt instructs the model to preserve Business Central placeholders (`%1`, `%2`, etc.). Results with changed placeholders are rejected and remain untranslated rather than being written incorrectly.

## Conflict handling

A source text is the unique key in `.lng`. Translation lookup is intentionally limited to the `.lng` file that belongs to the XLIFF currently being processed; other workspace `.lng` files are not consulted.

## Notes

- `.g.xlf` is excluded by default.
- Translation files are expected to use XLIFF 1.2 as generated by Business Central.
- The extension updates target elements while preserving the rest of each XLIFF `trans-unit` as much as possible.

## Developer comment translations

Before generic translation-memory lookup and AI fallback, the extension inspects XLIFF notes generated from AL `Comment = ...` values. Only notes with `from="Developer"` are treated as explicit developer translations.

Supported forms include both classic Business Central/NAV language codes and BCP-47 language tags:

```xml
<note from="Developer" annotates="general" priority="2">DEU=Auswertungsmonat</note>
```

```xml
<note from="Developer" annotates="general" priority="2">DEU=Auswertungsmonat; ENU=Evaluation Month</note>
```

```xml
<note from="Developer" annotates="general" priority="2">de-DE=Auswertungsmonat; en-US=Evaluation Month</note>
```

For a `target-language="de-DE"`, `DEU` and `de-DE` are therefore equivalent lookup keys. Normal placeholder documentation such as `%1 = Customer No.; %2 = Posting Date` is not interpreted as a translation.

The resolution order is fixed:

1. explicit translation in the unit's Developer comment;
2. companion `.lng` translation memory (exact match, then optional fuzzy match);
3. VS Code Language Model / Copilot fallback.

A fuzzy result is a review candidate, not an unresolved translation: it is marked `needs-review-translation`, is not sent to AI in the same or later run, and is not written back into `.lng` until it has been confirmed by changing its state to a completed state.

Translations are resolved per `trans-unit`. A Developer translation attached to the exact unit always wins, even when the same English source occurs elsewhere with a different Developer translation. If a unit has no direct Developer translation, a unique Developer translation from another missing unit with the same source may be reused; conflicting alternatives are not guessed. Because `.lng` permits only one translation per English source, context-specific conflicting translations are not collapsed into a single `.lng` row.

## Validation and quality checks

- **Duplicate id detection** (`bcXliffLanguageMap.validation.checkDuplicateIds`, default on): a file with duplicate `trans-unit` ids is skipped with a warning instead of being partially processed.
- **Duplicate generator-note detection** (`bcXliffLanguageMap.validation.checkDuplicateGeneratorNotes`, default on): independently checks duplicate `Xliff Generator` notes so this validation can be enabled/disabled separately from duplicate ids.
- **maxwidth check** (`bcXliffLanguageMap.validation.checkMaxWidth`, default on): reports how many filled target texts exceed the `maxwidth` attribute of their `trans-unit`.
- **Fuzzy translation-memory match** (`bcXliffLanguageMap.fuzzyMatch.enabled`, default off; `bcXliffLanguageMap.fuzzyMatch.minimumQuality`, default 80): when no exact `.lng` match exists, the closest Levenshtein-similarity match above the configured quality is applied and marked `state="needs-review-translation"` with a note naming the matched source and quality percentage. Fuzzy matches are never written back into `.lng` and are not subsequently passed to AI.
- **Source-change synchronization** (`bcXliffLanguageMap.sourceChangeDetection.enabled`, default on): the extension first looks for the exact generator companion by filename (`MyApp.de-DE.xlf` → `MyApp.g.xlf`). If no exact filename exists, a single unambiguous `*.g.xlf` in the folder may be used; with multiple candidates it refuses to guess. Changed source text is copied into the translation XLIFF before lookup. Existing translated/review targets become `needs-l10n`; untranslated targets continue through comment → `.lng` → AI. Other `BC.XliffMap` notes do not suppress source-change handling.

## Merging translations between files

**BC XLIFF: Merge Translations Between Files** copies translations from one already-translated XLIFF file into another, matching trans-units by id, then by `Xliff Generator` note, then by a uniquely occurring source text. Three modes are available:

- **Untranslated** — fills targets that are empty, `new`, or `needs-translation`. Review/adaptation/l10n targets are preserved.
- **Overwrite** — always replaces the target text of a matched trans-unit.
- **Add** — inserts whole trans-units that exist in the source file but are entirely missing from the target file.

Every merged trans-unit is marked `state="needs-adaptation"` with a review note; nothing merged this way is ever marked `translated` automatically. Merge is blocked when source/target language pairs differ or when either XLIFF is structurally ambiguous (for example duplicate trans-unit ids). Re-running a merge does not duplicate the merge review note.
