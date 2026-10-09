# AL Xliff Studio


### Visual XLIFF editing workflow

The visual editor uses an explicit staging workflow: **⇄ Sync → ? Try Translation / AI → review proposals → ← Proposals to Drafts → ✓ Apply Drafts → translated**. Try/AI actions and manual Translation edits do not change the XLIFF target text or workflow state immediately. Instead, staged Translation drafts and Proposal drafts are persisted as `AL.XliffStudio` `<note>` metadata inside the affected trans-unit, so paid AI results survive VS Code restarts. Use **←** / **← Proposals to Drafts** to promote reviewed proposals into Translation drafts. Use the per-row **✓** for one Translation draft or **✓ Apply Drafts** for all Translation drafts to write real `state="translated"` targets. Proposal drafts are never applied implicitly. Leaving a field never changes the target status.

The blue **Save** button writes already-applied XLIFF document changes to disk and is enabled only while the VS Code document is dirty. It does **not** apply staged Translation or Proposal drafts; those continue to use the explicit row **✓** / **✓ Apply Drafts** workflow. A successful Save also refreshes the Quality Check (including staged drafts as preview values) and updates diagnostics without forcing a hidden Quality panel open.

For a single row, the **✓** button under Translation is also an explicit commit action. It accepts an existing review/no-state target, or applies that row's changed Translation draft directly and sets it to `translated` even if the persisted target was already `translated`. This does not require a batch **Apply Drafts** operation.

The top **✓ No State** action confirms all existing non-empty `(no state)` targets in the current XLIFF in one operation. It always shows a modal confirmation with the number of affected translations before changing anything, updates the companion `.lng`, and skips rows with placeholder mismatches.

The visual editor paginates XLIFF rows and renders only the current page. Page size can be set to **50**, **100**, or **200** entries. A loading overlay is shown whenever a new XLIFF state is read/prepared or a page must be recomputed after paging, filtering, sorting, or changing the page size; the overlay shows the current stage and `loaded / total` progress.

**⇄ Sync** also creates/updates the companion `.lng`. Confirmed translations from the pre-sync XLIFF are preserved first, so an old source remains available to fuzzy matching after the generator changes that source. The generated `.g.xlf` is also authoritative for `from="Developer"` notes on each current trans-unit: changed/new Developer notes are mirrored into the translation XLIFF and stale Developer notes are removed, while unrelated notes and AL Xliff Studio metadata are preserved.

The quick category filters **Missing**, **Review**, **No State**, **Proposals**, **Drafts**, **Placeholder errors**, **Terminology**, and **Quality** are OR-combined. Global search and per-column filters still narrow the result in addition to that category selection. **No State** shows the saved, non-empty targets eligible for the toolbar action, excluding placeholder mismatches and non-translatable units; draft text is not counted. The Quality accordion appears above this filter bar.

AI fallback groups unresolved units by exact source text before batching. Only one representative per source is submitted, using the first occurrence’s AL context. Its validated translation is reused for every matching unresolved unit as a proposal draft. Case, whitespace and placeholders remain significant; existing targets, drafts and local suggestions are preserved. Grouping is scoped to one invocation and target language.

## Installation

Install the latest VSIX package with **Extensions: Install from VSIX...** in the VS Code Command Palette. No npm dependencies are required at runtime.

VS Code extension for Microsoft Dynamics 365 Business Central AL projects. Project-local AL Xliff Studio data is kept below `.alxliffstudio` beside the nearest `app.json`, while `Translations/` remains reserved for XLIFF files.




## AL source translation hover

AL Xliff Studio can show the available XLIFF translations directly while working in an `.al` file. Hover a translatable string such as a `Caption`, `ToolTip`, `InstructionalText`, `OptionCaption`, or `Label` value to see one entry per target language. Label declarations also work when hovering the label variable name on its declaration line.

Each language is a clickable command link. Selecting it opens that language's XLIFF in the **AL Xliff Studio — XLIFF Editor**, changes to the correct paginated page, scrolls to the matching `trans-unit`, and highlights it. Missing targets are shown as missing but still link to the unit so they can be translated immediately.

The lookup first tries to resolve the exact generator `trans-unit` from the current AL context (object type/name, field/action/control name, property such as Caption/ToolTip, and the Xliff Generator note). It then uses the same `trans-unit id` across the language XLIFF files. This avoids jumping to the wrong entry when the same English source text occurs multiple times. If no generator match can be resolved, exact source matching with the same contextual scoring is used as a fallback.

The parsed XLIFF index is cached and invalidated when XLIFF files change, so repeated hovers do not reparse the complete translation set. The feature can be disabled for exceptionally large workspaces with:

```json
"alXliffStudio.hover.enabled": false
```

## Translation provenance and history

AL Xliff Studio tracks where translation drafts and proposals come from. The visual XLIFF editor shows the current origin directly below the Translation or Proposal field and keeps an expandable history for persisted translations. Supported origins include **Developer comment**, **.lng translation memory**, **Glossary**, **Fuzzy** (including similarity and matched source), **AI** (including the selected VS Code language-model metadata), **Manual**, **Human accepted**, **Status confirmation**, and **XLIFF merge**.

Provenance follows the staging workflow. `Try Translation`, row `Try`, Fuzzy, AI, and manual staging persist draft/proposal metadata (including provenance) as `AL.XliffStudio` XLIFF notes without changing the actual target translation. When a staged translation is committed through the per-row **✓** or **✓ Apply Drafts**, the staging note is removed and the applied provenance event is persisted next to the target as an `AL.XliffStudio` XLIFF note. Existing review/no-state targets accepted with **✓** receive a human-acceptance event, and explicit completion through the status selector records a status-confirmation event. Merge operations record merge lineage as well.

Example persisted metadata:

```xml
<target state="translated">Öffnen</target>
<note from="AL.XliffStudio" annotates="general" priority="1">Provenance: {"v":1,"at":"...","origin":"ai","action":"applied","model":{"id":"...","vendor":"copilot"}}</note>
```

The raw structured Provenance notes are intentionally hidden from the normal Notes column; the editor renders them as compact origin badges and an expandable **History** list instead. They remain part of the XLIFF so the lineage survives closing VS Code, source-control commits, and reopening the project. Manual edits are marked **Manual** and retain a compact `basedOn` reference when they were derived from an AI/Fuzzy/.lng/etc. draft. Global search also includes provenance text.

Provenance is disabled by default and can be enabled with `alXliffStudio.provenance.enabled`. When disabled, new translation actions do not append Provenance notes and provenance badges/history are not shown. Existing persisted provenance notes are preserved in the XLIFF and remain hidden from the ordinary Notes column.

## Project-wide Translation Dashboard

The **AL Xliff Studio** icon in the VS Code Activity Bar opens the compact project navigator on the left and automatically opens the full Translation Dashboard in the editor area. Its **Languages** section shows each translation locale with Missing/Review/Quality status and opens the corresponding XLIFF directly; `supportedLocales` without an XLIFF appear as **Not created** and can be generated from the matching `.g.xlf`. **Tools** provides shortcuts to the Translation Dashboard, Glossary, AI Usage, Sync all XLIFFs, project-wide Quality Check, and Refresh. **Project** links to `app.json`, generated `.g.xlf`, `.alxliffstudio`, Translation Memory, Glossary, and the AI Debug Log when debug mode is enabled.

Run **AL Xliff Studio: Open Translation Dashboard** to scan every translation XLIFF matched by the configured workspace glob. The dashboard shows one row per XLIFF with project/path, source and target language, generator synchronization state, translated percentage, translated units, missing units, review units, placeholder errors, and aggregate quality issues. It also reads `supportedLocales` from each AL project's `app.json`: a supported target locale with no translation XLIFF is shown as **Not created**. When exactly one generated `Translations/*.g.xlf` is available, **Generate XLIFF** creates the missing locale file directly from it with empty `needs-translation` targets; the generator source language is not treated as a missing translation locale.

The dashboard has a dedicated **AI Usage** button instead of embedding token telemetry in the translation overview. It opens a separate persistent AI Usage page with all-time project totals, current-session totals, model breakdown, language-pair breakdown, daily usage, project breakdown, and recent AI requests. Token values are calculated with the selected VS Code language model's `countTokens(...)` tokenizer and are diagnostic usage statistics, not a provider billing statement; cached, hidden-reasoning, and provider-specific billing tokens can differ. Collection can be disabled with `alXliffStudio.ai.usage.enabled`. Existing persisted statistics stay readable when collection is disabled.

For troubleshooting model-specific response formats, enable `alXliffStudio.debug.enabled`. Debug mode stores the exact AI prompt, raw model response, parsed result/error, model metadata, and language pair in `.alxliffstudio/debug/ai-debug.log`. The debug directory is ignored by Git by default because prompts and responses can contain project translation text. Use **AL Xliff Studio: Open AI Debug Log** to open the file directly. Keep debug mode disabled during normal use.

The **Sync** column compares each translation XLIFF against its matching `.g.xlf` using the same synchronization routine as the visual editor. It distinguishes **✓ Synced**, **⇄ Out of sync**, **— No .g.xlf**, and **! Error**. Hovering the status shows the detected synchronization differences.

Use **⇄ Sync all XLIFFs** to synchronize every dashboard XLIFF with its unambiguous matching `.g.xlf` in one pass. Existing targets for current units are preserved, changed sources are flagged for review where appropriate, `from="Developer"` notes are mirrored from the generated unit, missing units are inserted in generator order, and units that no longer exist in the `.g.xlf` are removed from the translation XLIFF. Before removal, confirmed source/translation pairs from the pre-sync XLIFF are merged into the companion `.lng`, so deleted or `Locked = true` AL texts remain available as translation memory.

The counts are actionable: clicking **Missing**, **Review**, **Translated**, or **Quality** opens that XLIFF in the visual editor and applies the matching filter immediately. The dashboard rescans automatically when a XLIFF document is saved and can also be refreshed manually with **↻ Refresh**.

The top summary aggregates all detected translation XLIFF files across the workspace, including language count and overall completion. Files with duplicate trans-unit ids or duplicate Xliff Generator notes are flagged with structural warnings.



## XLIFF Quality Check

The visual XLIFF editor includes **! Quality Check**. It validates the current file without silently changing translations. Staged Translation/Proposal drafts are included in the check as the values that would be applied. Their staging metadata can already be persisted in the XLIFF, but they are not treated as target translations until explicitly committed with the row **✓** or **✓ Apply Drafts**.

The quality check reports errors, warnings, and informational findings in an integrated results panel. Every unit-level finding has **Go**, which clears conflicting view filters, navigates to the correct page, and scrolls to the affected translation unit. The same results are also published to VS Code's native **Problems** view. Problems clicks remain standard VS Code navigation and are never intercepted; instead, AL Xliff Studio offers the Quick Fix **AL Xliff Studio: Show translation unit** for unit-level AL Xliff Studio diagnostics. The Quick Fix uses navigation metadata captured when the Diagnostic was created and opens the visual editor directly at that unit. Disable this complete Problems-to-XLIFF Quick Fix feature with `alXliffStudio.quality.problemsNavigation.enabled`. Warning/Info findings can still be ignored locally per translation unit; a separate globe/slash action ignores the complete Quality rule project-wide. Project-wide rule ignores are stored in `.alxliffstudio/quality-ignores.json` and remain visible under **Ignored**, where a plain globe restores the rule.

Quality Check also runs automatically in the background by default. When a workspace/project opens, AL Xliff Studio scans every translation XLIFF matched by `alXliffStudio.xliffGlob` (generated `.g.xlf` files stay excluded) and publishes the findings to **Problems**. Results are refreshed after XLIFF saves/file-system changes, glossary changes, workspace-folder changes, and relevant Quality/Glossary settings changes. The automatic background checks can be disabled with `alXliffStudio.quality.autoRun.enabled`; the explicit **! Quality Check** and command remain available. To protect large-file performance, raw unsaved typing does not trigger a workspace-wide full check on every keystroke.

Checks currently include:

- missing/different placeholders (`%1`, `%2`, `#1`, brace placeholders) as hard errors, plus a separate warning when the same placeholders appear in a different order,
- lost/added actual line breaks and AL backslash line-break markers; C-style escape spellings are not validated,
- `maxwidth` violations,
- source text equal to target text,
- leading/trailing whitespace differences and accidental repeated spaces/tabs in the target,
- missing, added, or differing final punctuation; terminal periods that belong to recognized abbreviations (for example `No.`, `Nr.`, `z. B.`, `u. a.`, and dotted acronyms) are deliberately not treated as sentence punctuation; a lone final letter such as `H.` remains sentence punctuation,
- unusually strong target/source length deviations using conservative thresholds,
- inconsistent targets for the same source within one XLIFF,
- suspicious reuse of the same meaningful target for different sources,
- project glossary / terminology violations,
- malformed/stale NAB workflow markers or NAB notes left on completed translations,
- invalid/unknown XLIFF target states and empty targets marked as completed,
- duplicate `trans-unit` ids and duplicate `Xliff Generator` contexts,
- optional likely untranslated English source words copied into non-English targets.

The **Quality** quick filter isolates rows with QA findings and is OR-combined with the other quick filters. The Translation Dashboard also exposes a project-wide **Quality** count per XLIFF; clicking it opens the file with the Quality filter already active.

Quality results open as a collapsible accordion above the Translation Units viewport. The QA result list and the translation table scroll independently. **Go** changes to the correct paginated page and scrolls only the Translation Units viewport to the affected `trans-unit`, so the selected QA result remains visible in its own list.

Quality behavior can be tuned with these settings:

- `alXliffStudio.quality.checkSourceEqualsTarget` (default `true`)
- `alXliffStudio.quality.checkWhitespace` (default `true`)
- `alXliffStudio.quality.checkRepeatedWhitespace` (default `true`)
- `alXliffStudio.quality.checkPunctuation` (default `true`)
- `alXliffStudio.quality.checkPlaceholderOrder` (default `true`)
- `alXliffStudio.quality.checkFormattingSequences` (default `true`; also flags invalid C/C#-style `\n`, `\r`, `\r\n`, `\t`, etc. because AL uses the backslash itself as the line-break marker)
- `alXliffStudio.quality.checkLengthDeviation` (default `true`)
- `alXliffStudio.quality.checkNabResidues` (default `true`)
- `alXliffStudio.quality.checkInconsistentTranslations` (default `true`)
- `alXliffStudio.quality.checkSharedTargets` (default `true`)
- `alXliffStudio.quality.checkCopiedSourceTerms` (default `false`, because product/technical terms can otherwise cause false positives)

`alXliffStudio.validation.checkMaxWidth` continues to control max-width validation, and terminology checks follow `alXliffStudio.glossary.enabled`.

## Project data directory

AL Xliff Studio keeps its own project data in a dedicated directory **beside the nearest `app.json`**, not below `.vscode`:

```text
<AL project>/
├─ app.json
├─ Translations/
│  ├─ App.g.xlf
│  ├─ App.de-DE.xlf
│  └─ App.fr-FR.xlf
└─ .alxliffstudio/
   ├─ .gitignore
   ├─ glossary.json
   ├─ quality-ignores.json
   ├─ ai-usage.json
   └─ lng/
      ├─ App.de-DE.lng
      └─ App.fr-FR.lng
```

This placement is intentional. `.vscode` is reserved for VS Code workspace/editor configuration, while translation memory, terminology, and tool statistics belong to the AL project and should also work independently of how that project is opened in VS Code. It also behaves correctly in a workspace containing several AL apps because each `app.json` gets its own `.alxliffstudio` directory.

Companion `.lng` files are stored under `.alxliffstudio/lng/`; legacy `.lng` files beside XLIFFs are migrated automatically, so `Translations/` can contain XLIFFs only. The glossary and `quality-ignores.json` are meant to be version-controlled together with the project. `ai-usage.json` is intentionally local/noisy telemetry and `.alxliffstudio/.gitignore` excludes it by default, while leaving `glossary.json`, `quality-ignores.json`, and `lng/` trackable.

## Terminology glossary

Run **AL Xliff Studio: Open Terminology Glossary** or use the monochrome **T** button in the XLIFF editor/dashboard. By default the glossary is stored as `<AL project>/.alxliffstudio/glossary.json`, where `<AL project>` is the nearest folder containing `app.json`. A legacy `.al-xliff-glossary.json` is migrated automatically when it can be resolved unambiguously. You can still pin another location with `alXliffStudio.glossary.path`; an explicitly configured custom path always wins. If several legacy glossary files exist and no path is configured, **Open Terminology Glossary** asks you to choose one instead of guessing.

The glossary stores source terms per target language with a required translation, match mode (`word`, `exact`, or `contains`), optional case sensitivity, and a note. Example:

```json
{
  "version": 1,
  "entries": [
    {
      "source": "Customer",
      "targetLanguage": "de-DE",
      "translation": "Debitor",
      "match": "word",
      "caseSensitive": false,
      "note": "Business Central terminology"
    }
  ]
}
```

Terminology is used in three ways:

- **Exact lookup:** after Developer comments and exact `.lng` lookup, an exact glossary source match becomes a Translation draft / deterministic translation before fuzzy matching or AI.
- **Terminology validation:** when a source contains a glossary term but Translation/Proposal does not contain the required target term, the XLIFF editor shows a terminology warning and the **Terminology** quick filter can isolate those rows.
- **AI guidance:** relevant glossary terms are attached to the AI request so the model is explicitly instructed to use project terminology consistently.

Each XLIFF row also has **T+** to create/update a glossary rule using that row as a starting point.

## Main workflow

1. Run **AL Xliff Studio: Build/Update Language Maps**.
2. For every translation `.xlf` except `.g.xlf`, the extension creates/updates a companion map such as `.alxliffstudio/lng/MyApp.de-DE.lng`.
3. The `.lng` file contains one unique English source string and one translation per row.
4. After AL refactoring/regeneration changes XLIFF ids, run **AL Xliff Studio: Fill Missing Translations**.
5. Missing targets are resolved in this fixed order:
   - explicit translation from the unit's Developer comment,
   - companion `.lng` translation memory (exact source match),
   - project terminology glossary (exact source-term match),
   - optional fuzzy `.lng` match, staged/flagged for review,
   - VS Code Language Model API when enabled.
   Review states such as `needs-review-translation`, `needs-adaptation`, and `needs-l10n` are preserved for human review and are not sent to AI.
6. If entries still need AI, the extension asks for permission on every translation run before sending any request. Successful AI translations are written both to the XLIFF and the companion `.lng` file.
7. Before translation lookup, the extension synchronizes changed `<source>` text from the matching sibling `.g.xlf` file by trans-unit id. Existing usable targets are preserved as `state="needs-l10n"` with a source-change review note; empty/new/`needs-translation` targets remain eligible for the normal translation pipeline.
8. Use **AL Xliff Studio: Merge Translations Between Files** to copy translations between two already-translated XLIFF files (e.g. from a similar app) without going through `.g.xlf`/comments/AI.

### NAB AL Tools compatibility

AL Xliff Studio supports both NAB AL Tools workflow styles. Normal XLIFF target states (`new`, `needs-review-translation`, `needs-adaptation`, etc.) are handled directly. When NAB uses its default text markers instead of target states, `[NAB: REVIEW]`, `[NAB: SUGGESTION]`, and `[NAB: NOT TRANSLATED]` are treated as workflow metadata rather than translation text. The marker is hidden from the editable translation value, review/missing metrics remain correct, and marked targets are never written into the companion `.lng` translation memory.

When AL Xliff Studio resolves or explicitly accepts such a row, it removes the textual NAB marker and the corresponding `note from="NAB AL Tools"`, then writes the normal XLIFF target state (`translated`, `needs-review-translation`, `needs-l10n`, etc.) required by the Studio workflow. Unrelated Developer, Xliff Generator, and AL.XliffStudio notes are preserved.

## `.lng` format

The raw file is deliberately simple and Git-friendly:

```text
# AL Xliff Studio Language Map v1
# Language: de-DE
"Encoding time"\t"Kodierungszeit"
"Invalid barcode."\t"Ungültiger Barcode."
```

Both values are JSON strings separated by a TAB. This safely preserves quotes, tabs and line breaks while still producing a true two-column text format.

## Visual editor

Files named `*.<language>.lng` open with **AL Xliff Studio — Language Map**. The editor provides:

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

Files ending in `.xlf` open with **AL Xliff Studio — XLIFF Editor**. Translation XLIFF files are editable; generated `.g.xlf` files (and XLIFF files without a `target-language`) are deliberately read-only. Use **</>** or **Reopen Editor With...** to inspect the raw XML.

The editor is designed around an explicit review workflow:

`⇄ Sync → ? Try Translation / AI → review proposals → ← Proposals to Drafts → ✓ Apply Drafts → translated`

### 1. Synchronize

**⇄ Sync** synchronizes the current translation XLIFF with the matching sibling `.g.xlf`. It updates changed Source values, mirrors the complete `from="Developer"` note set from the generated unit, adds generator trans-units that are missing from the translation file **at the same position/order as in the `.g.xlf`**, removes translation units whose IDs no longer occur in the `.g.xlf`, and marks preserved targets for review when their Source changed. Existing translations stay attached to current trans-units while all current units are reordered to match the generated base file. Confirmed translations from the pre-sync XLIFF are merged into the companion `.lng` before obsolete units disappear, so removed AL texts remain reusable as translation memory. Synchronization is structural only: it never performs translation lookup and never creates proposals.

### 2. Try Translation

**? Try Translation** processes all currently missing targets. Each row also has a **? Try** button for the same workflow on only that trans-unit. During this phase no target translation/state is changed; the proposed/draft text is stored only as AL Xliff Studio staging metadata inside the trans-unit:

1. explicit Developer-comment translation → staged as an editable **Translation draft**;
2. exact companion `.lng` match → staged as an editable **Translation draft**;
3. exact project glossary match → staged as an editable **Translation draft**;
4. optional fuzzy `.lng` match → staged in **Proposed translation** for review;
5. if still unresolved, the editor asks whether AI may be used; an AI result is staged in **Proposed translation** and receives matching glossary terminology as context.

The whole-file AI question contains only the rows that genuinely reached the AI stage. Fuzzy proposals are not sent to AI. The per-row **AI** button is an explicit AI-only staging action and also never modifies the XLIFF by itself.

### 3. Review proposals and drafts

The narrow column between Translation and Proposed translation contains a monochrome **←** button. It moves a valid proposal into the editable **Translation draft** field and removes the proposal. Only the persisted staging note changes; the real XLIFF target text and status remain untouched. **← Proposals to Drafts** performs the same staging move for all currently visible valid proposals.

Proposal text itself is editable. Placeholder mismatches are shown in red. A proposal remains non-committable while it is in the Proposal column. Move it with **←** (or **← Proposals to Drafts**) before **✓ Apply Drafts** can commit it.

### 4. Apply staged changes

Translation textareas are draft-based. Typing or Try/AI can update the AL Xliff Studio staging note, but they do **not** replace the real target text and do **not** alter its workflow state. Staged values are restored when the XLIFF editor or VS Code is reopened.

- **✓ Apply Drafts** commits Translation drafts only. Proposal drafts deliberately remain proposals until reviewed and moved with **←** / **← Proposals to Drafts**. Drafts are committed to the XLIFF in one batch pass; larger operations can show a delayed progress overlay. The per-row **✓** commits one Translation draft directly. Every valid committed translation is written as `state="translated"` and then added to the companion `.lng` translation memory.
- Rows with placeholder mismatches or empty staged values are skipped and remain visible for correction.
- **↶** discards one manual Translation draft; **↶ Discard Drafts** discards all staged Translation and Proposal drafts and removes their staging notes from the XLIFF.
- `Escape` discards the current manual Translation draft. There is no per-row save/commit shortcut.
- The editor blocks Sync, Try Translation, and switching to raw XML while staged changes exist so a review set cannot be lost accidentally.

Status changes outside this staging workflow remain explicit. Any already-persisted, non-empty Translation whose state is not yet completed shows a monochrome **✓** action directly below the Translation field. This accepts the currently persisted target **without creating a draft**, sets its state to `translated`, updates the companion `.lng`, and clears a stale proposal for the row. It is intended for states such as `needs-l10n`, `needs-adaptation`, `needs-review-*`, `needs-translation`, `new`, or a target without a state. Completed states (`translated`, `signed-off`, `final`) do not show the action, and placeholder-invalid targets cannot be accepted.

A non-empty `<target>` **without a `state` attribute** is treated as **Review**, not as Missing and not as confirmed Translated. It is therefore excluded from `.lng` translation memory and from AI/Fill processing until explicitly accepted with **✓**. An empty target without state remains **Missing**. If Sync detects that the Source changed while such an unconfirmed target exists, the target is preserved and promoted to `needs-l10n`.

### Navigation, filtering and validation

The table shows **Source**, **Translation**, **Proposed translation**, **Status**, **Notes**, and actions. Every data column has its own contains-filter and sortable header. Sorting only changes the view and never reorders XLIFF trans-units. A global search covers Source, Translation, Proposal, Status, Notes, id and proposal origin. Quick filters are available for **Missing**, **Review**, **Proposals**, **Drafts**, **Placeholder errors**, **Terminology**, and **Quality**. **Drafts** includes any staged Translation or Proposal change; the **Proposals** filter is the narrower subset for rows that still have a proposal.

Per row, **⌕** navigates directly to the matching AL Label/Caption/ToolTip definition, while **</>** opens the raw XLIFF at the current `trans-unit`. All workflow symbols are plain text and inherit the VS Code foreground color; no colored icon assets are used.

Large XLIFF files use pagination instead of rendering every trans-unit at once. Use the page-size selector for **50 / 100 / 200** entries and the `« ‹ page / pages › »` controls to move through the filtered/sorted result. The summary shows the current range (for example `101–200 of 437 filtered · 8,420 total`). Paging, filter/sort changes and document reloads show the loading overlay while the new page is prepared and rendered.

For very large XLIFFs, parsing and Quality Check are automatically offloaded to Node worker threads so the VS Code extension host can keep processing UI/events. The default threshold is **3 MiB or 5,000 trans-units**. Configure this with `alXliffStudio.performance.workerThreads.enabled`, `alXliffStudio.performance.workerThreads.minFileSizeMB`, and `alXliffStudio.performance.workerThreads.minUnits`. If worker startup fails, AL Xliff Studio falls back to the normal in-process path. Parsed XLIFF snapshots are also held in a count- and memory-bounded DocumentSession LRU cache; `alXliffStudio.performance.documentSessionCacheMB` controls the approximate memory budget (default **384 MiB**) while active editor documents stay pinned.

Additional safeguards:

- `translate="no"` units are visible but cannot be edited or sent to AI.
- Source/Translation and Source/Proposal placeholders (`%1`, `%2`, `#1`, and brace placeholders) are compared. Mismatches are displayed in red per row. C-style escaped control sequences are not placeholders in Business Central.
- `maxwidth` is shown as `current length / maxwidth`; violations are highlighted.
- A non-empty target without `state` is reported by Quality Check as a review warning (`Target contains translation text but has no state`) and is included by the **Review** filter.
- Duplicate trans-unit ids and duplicate `Xliff Generator` notes are surfaced as warnings.
- `.g.xlf` files are read-only in the visual editor.
- **↻** refreshes the view without generating proposals.


## Commands

- `AL Xliff Studio: Open Translation Dashboard`
- `AL Xliff Studio: Open AI Usage`
- `AL Xliff Studio: Open AI Debug Log`
- `AL Xliff Studio: Build/Update Language Maps`
- `AL Xliff Studio: Fill Missing Translations`
- `AL Xliff Studio: Fill Missing Translations in Current File`
- `AL Xliff Studio: Select Translation AI Model`
- `AL Xliff Studio: Merge Translations Between Files`
- `AL Xliff Studio: Open Visual XLIFF Editor`
- `AL Xliff Studio: Run XLIFF Quality Check`
- `AL Xliff Studio: Open Terminology Glossary`

## AI behavior

AI is only used from an explicit translation action and only after the deterministic lookup chain has been exhausted: **Developer comment → exact companion `.lng` → exact project glossary → optional fuzzy `.lng` → AI**. Only translation units that really reach the AI stage are counted in the confirmation dialog. Choosing **Continue without AI** keeps all deterministic/staged work and leaves the remaining units untouched. The permission is not persisted. While AI translation is running, the VS Code notification popup at the bottom right shows a progress bar and a `completed / total` counter that advances after each AI batch. Percentage increments are calculated from the newly completed delta, so the bar reaches 100% only after the final batch has completed. The extension uses VS Code's Language Model API. The default vendor is `copilot`; you can choose an exact available model with the model-selection command. The picker only lists models that AL Xliff Studio can consume through the VS Code text-response API. Providers known to register models without a usable `LanguageModelChatResponse.text` stream (currently `copilotcli`) are excluded, and duplicate logical models prefer the standard `copilot` provider. The same compatibility check is applied when a saved model setting is resolved, so a stale incompatible provider setting cannot silently be used for translation.

### Context-aware Business Central AI

With `alXliffStudio.ai.context.enabled` (default on), every AI item receives structured context for its exact `trans-unit` instead of only the English source text. Context can include:

- the complete `Xliff Generator` hierarchy (for example `Page Customer List → Action Open → Property Caption`) plus parsed object type/name, element and property;
- Developer notes, including semantic descriptions and placeholder explanations;
- the current target and XLIFF state when a review/adaptation target already exists;
- source placeholders and `maxwidth`;
- nearby translation units from the same AL object, including confirmed neighboring translations;
- other occurrences of the same English source in different AL contexts;
- the strongest similar, confirmed examples from the companion `.lng` translation memory;
- relevant project glossary terminology.

Identical English texts are sent as separate AI items when they belong to different `trans-unit`s. For example, `Open` used as an Action Caption and `Open` used as a field/status value can therefore receive different translations based on their AL context. Results are keyed back to the exact unit, not only to the source string.

Context size is bounded before it is sent to the language model. Broad context such as nearby units and translation-memory examples is trimmed before authoritative generator metadata and Developer notes. The relevant settings are `alXliffStudio.ai.context.nearbyUnits`, `translationMemoryExamples`, `minimumMemorySimilarity`, `sameSourceContexts`, and `maxCharactersPerItem`.

The prompt instructs the model to preserve Business Central placeholders (`%1`, `%2`, etc.), respect required glossary terminology, use `maxwidth` as a concision hint, and treat confirmed `.lng` examples as style/context rather than text to copy blindly. Results with changed placeholders are rejected and remain untranslated rather than being written incorrectly.

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
2. companion `.lng` translation memory (exact match);
3. exact project glossary match;
4. optional fuzzy companion `.lng` match (review proposal);
5. VS Code Language Model / Copilot fallback with structured AL/XLIFF context.

A fuzzy result is a review candidate, not an unresolved translation: it is marked `needs-review-translation`, is not sent to AI in the same or later run, and is not written back into `.lng` until it has been confirmed by changing its state to a completed state.

Translations are resolved per `trans-unit`. A Developer translation attached to the exact unit always wins, even when the same English source occurs elsewhere with a different Developer translation. If a unit has no direct Developer translation, a unique Developer translation from another missing unit with the same source may be reused; conflicting alternatives are not guessed. Because `.lng` permits only one translation per English source, context-specific conflicting translations are not collapsed into a single `.lng` row.

## Validation and quality checks

- **Duplicate id detection** (`alXliffStudio.validation.checkDuplicateIds`, default on): a file with duplicate `trans-unit` ids is skipped with a warning instead of being partially processed.
- **Duplicate generator-note detection** (`alXliffStudio.validation.checkDuplicateGeneratorNotes`, default on): independently checks duplicate `Xliff Generator` notes so this validation can be enabled/disabled separately from duplicate ids.
- **maxwidth check** (`alXliffStudio.validation.checkMaxWidth`, default on): reports how many filled target texts exceed the `maxwidth` attribute of their `trans-unit`.
- **Fuzzy translation-memory match** (`alXliffStudio.fuzzyMatch.enabled`, default on; `alXliffStudio.fuzzyMatch.minimumQuality`, default 80): when no exact `.lng` match exists, the closest Levenshtein-similarity match above the configured quality is applied and marked `state="needs-review-translation"` with a note naming the matched source and quality percentage. Fuzzy matches are never written back into `.lng` and are not subsequently passed to AI.
- **Source-change synchronization** (`alXliffStudio.sourceChangeDetection.enabled`, default on): the extension first looks for the exact generator companion by filename (`MyApp.de-DE.xlf` → `MyApp.g.xlf`). If no exact filename exists, a single unambiguous `*.g.xlf` in the folder may be used; with multiple candidates it refuses to guess. Changed source text is copied into the translation XLIFF before lookup. Explicit Sync additionally mirrors `from="Developer"` notes from the matching `.g.xlf` while preserving unrelated notes and the order of existing notes. Changed note contents are replaced in place, matching notes keep their slots even if the generator lists them in another order, and additional notes are inserted beside existing notes of the same kind. Existing translated/review targets become `needs-l10n`; untranslated targets continue through comment → `.lng` → AI. Other `AL.XliffStudio` notes do not suppress source-change handling.

## Merging translations between files

**AL Xliff Studio: Merge Translations Between Files** copies translations from one already-translated XLIFF file into another, matching trans-units by id, then by `Xliff Generator` note, then by a uniquely occurring source text. Three modes are available:

- **Untranslated** — fills targets that are empty, `new`, or `needs-translation`. Review/adaptation/l10n targets are preserved.
- **Overwrite** — always replaces the target text of a matched trans-unit.
- **Add** — inserts whole trans-units that exist in the source file but are entirely missing from the target file.

Every merged trans-unit is marked `state="needs-adaptation"` with a review note; nothing merged this way is ever marked `translated` automatically. Merge is blocked when source/target language pairs differ or when either XLIFF is structurally ambiguous (for example duplicate trans-unit ids). Re-running a merge does not duplicate the merge review note.

## Quality exceptions and ignored findings

Quality Check distinguishes between hard errors and reviewable warnings/information. Local XLIFF exceptions remain deliberately limited to Warning/Info findings, while the project-level mechanism can suppress a deliberately reviewed Error, Warning, or Info without modifying the XLIFF itself:

- **Context-aware rules:** common UI abbreviations such as `No.`, `Qty.` and `Amt.` do not count as sentence-ending punctuation, while a lone final letter such as `H.` does. For example, `Customer No.` → `Debitornummer` no longer creates a punctuation warning.
- **Glossary exceptions:** glossary entries can define `quality.ignore`, for example `"quality": { "ignore": ["punctuation"] }`. The exception is active only when the glossary rule matches the source and its required translation is satisfied. The visual glossary editor exposes this as **Quality exceptions** (comma-separated Quality Check codes).
- **Per-unit ignore:** in the Quality Check accordion, Warning/Info rows have a `⊘` action. It stores a source/target-specific `QualityIgnore:` note in the corresponding trans-unit. The finding disappears from normal Quality results and VS Code Problems but remains visible under **Ignored**. Use **Restore** there to re-enable it. If source or target changes, the old exception no longer matches and the finding returns.
- **Project-wide rule ignore:** every active Error/Warning/Info has a globe/slash action beside the local action. It writes the Quality rule code to `<AL project>/.alxliffstudio/quality-ignores.json`. Every finding produced by that rule disappears from normal Quality results and Problems across all XLIFFs/languages in the AL project. Under **Ignored**, project-level findings are marked `ignored by project`; use the plain globe action to restore the complete rule.

Ignored findings stay auditable. XLIFF-local ignores remain in XLIFF metadata; project-wide exceptions remain in the separate, versionable project file; glossary-based suppressions show `ignored by glossary`.

### Performance debugging

For diagnosing a slow or apparently stuck XLIFF Editor, enable:

```json
"alXliffStudio.debug.performance.enabled": true,
"alXliffStudio.debug.performance.slowThresholdMs": 250
```

The extension writes `.alxliffstudio/debug/performance.log`. Use **AL Xliff Studio: Open Performance Debug Log** to open it. Each operation gets a trace id and phase timings. Long-running operations also emit `STILL-RUNNING` lines so the last completed phase identifies where an operation is spending time. The log includes counts and timing metadata, but not full translation contents. Disable the setting after diagnosis to avoid additional debug I/O.

From 1.11.54, traces also record worker starts/termination outcomes and event-loop maximum/p99 delays. Superseded workers are terminated before their replacements start; cancellation does not invoke a synchronous parser/Quality fallback. Document changes and closing invalidate running work independently of automatic Quality Check.

Quality findings stay in the extension host. The Quality panel requests only its current page (50/100/200 findings); severity filtering and stable sorting run in the host, with cached query indices for repeated page changes. Replies and ignore/restore actions are checked against the current report revision and document version.

The source distribution includes `npm run test:stress` for a deterministic 30,000-unit / approximately 15 MB scenario. It measures real editor-host handlers, worker threads, files, memory, event-loop stalls and transferred bytes. See `docs/large-xlf-stress.md` in the source distribution for scope, budgets and the separate rendered VS Code acceptance checklist.

## Roadmap and responsive Sync

The ordered roadmap is in `docs/roadmap.md`. Version 1.11.59 executes large editor/dashboard Sync and dashboard Sync-status computations in the existing cancellable worker. Translation-memory extraction happens in that worker; only compact pairs and synchronization results return to the host. Small files and explicitly disabled workers keep their existing path. Sync worker failure does not start a large blocking fallback. The stress runner now checks a 500-ms host-stall budget for Sync and 100-ms budgets for Quality filter/paging; remaining >100-ms phases remain visible for the next roadmap section. These are adapter regression thresholds, not guaranteed native UI latency.


### Guided Translation and dashboard actions (1.11.73)

Each existing translation XLIFF offers **Wizard** and **XLIFF Editor** in the Actions column. The Sync column shows a **Sync** button only when that file differs from its matching generator. Row Sync updates only the selected translation and its companion memory, then updates the dashboard row without resetting the filter.

The Wizard displays the selected language and XLIFF and offers New language, Missing translations, Review, Quality fixes and Synchronization. This initial common framework routes translation and review into the existing filtered editor; synchronization is scoped explicitly to the selected XLIFF. Detailed guided steps will build on this framework. Languages without an XLIFF retain the Generate XLIFF action.

### Guided Translation

Use the wand icon beside a dashboard XLIFF to choose a workflow for that language. Missing translations, review (No State, drafts and proposals), and quality fixes share one entry view. Edit a translation, explicitly use a proposal, request an AI suggestion, apply and advance, or skip. Applying changes the open document; Save writes it to disk. Skipped edited text is preserved as a draft, not accepted as a translation. Save & Quality Check ends with a summary. External edits stop further actions and preserve the visible text for recovery. The Expert Editor remains available for advanced work.

New language starts with optional Sync and local-source import preparation before the missing-translation workflow. Sync from this entry point affects the selected XLIFF only.

Guided Translation now provides a ¶ button to show the same invisible-character markers as the Expert Editor, including spaces, tabs, line breaks, nonbreaking spaces and zero-width characters. It decorates source, saved translation, editable translation, proposal and developer notes without changing their contents. The preference is retained in the webview state.

New language begins with a preparation page: check and optionally synchronize only the selected XLIFF, prepare local translations from Developer comments, exact .lng and glossary matches as drafts, then continue entry by entry. This import does not request AI or fuzzy matches and preserves existing staged text. Import edits the open document; Save writes it to disk. Sync may require saving existing document edits first.

### Guided navigation and completion

Previous/Next browses the workflow queue while preserving edited text as drafts in the open document. Back to selection and Expert Editor handoff also preserve current input without accepting it or implicitly saving to disk. Applying a revisited entry counts that entry once. The final summary shows remaining missing translations, skipped entries, drafts, proposals, review, quality issues and unseen entries. Follow-up buttons open the corresponding work; Skip review contains only the entries explicitly skipped in that run. Saving updates the selected dashboard language row, including when the dashboard is hidden.

In Project Overview, expand a language to open the Wizard or its New language, Missing, Review, Quality and single-file Sync workflows, or open the Expert Editor. Unavailable workflows have no command. Dashboard, Wizard, XLIFF Editor, language map, Glossary and AI Usage tabs use matching light/dark icons.
