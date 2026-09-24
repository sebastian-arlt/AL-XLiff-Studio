# Changelog

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
