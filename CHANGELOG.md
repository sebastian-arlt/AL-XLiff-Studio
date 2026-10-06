# 1.11.84

- Extension Details: Bilder und technische Referenz verwenden absolute GitHub-HTTPS-Adressen. Repository-Metadaten und Paketierung korrigiert.

# 1.11.83

- Rewritten extension Details page with concise German explanations, a short start guide and three screenshots of actual Dashboard, Guided Translation and Editor views using example data.
- Clearer command names and core setting descriptions in VS Code’s generated Features view. Technical material moved to docs/technical-reference.md.
- Images are bundled for local VSIX use; relative links are preserved during packaging.

# 1.11.82

- Guided Translation adds Previous/Next navigation, preserves edited text as a draft on navigation and handoff, and retains hidden webview state. Revisited accepted entries show current targets; counters count unique entries.
- Final summary reports missing, skipped, saved drafts, proposals, review, quality and unseen entries. Scoped follow-ups open missing, skipped-only, review or quality work only when available.
- Saving a known XLIFF updates its dashboard row even while that dashboard is hidden.
- Project Overview languages expand into Wizard, New language, Missing, Review, Quality, selected-file Sync and Expert Editor actions. Availability follows each language’s metrics.
- All six Studio webview/custom-editor tab types have themed SVG icons.

# 1.11.81

- Guided Translation automatically offers the target-language Developer translation as a separate proposal when the current entry has developer-comment-mismatch. It uses the existing language parser and quality result.
- Current translation and manual draft remain unchanged until explicit proposal selection and Apply. Developer-comment provenance is retained; foreign-language notes do not become proposals.

# 1.11.80

- Dashboard loading now matches the XLIFF Editor: slim nonblocking status strip at the top, two-pixel progress bar, stage and file count. Unknown totals animate; known progress is clamped.
- Uses the same 300 ms display delay to avoid flicker. Completion and errors cancel delayed display. Row-specific synchronization stays inline.

# 1.11.79

- Guided Translation enables Review only when the displayed review count is greater than zero; zero or unavailable counts disable the workflow. The host uses the same check before starting it.

# 1.11.78

- Guided Translation shows the ¶ toggle only beside the entry-view heading, where source and translation are visible. It is hidden in selection, preparation, completion and summary.
- Active ¶ toggle uses a solid blue background with white text; tooltip and accessible label reflect its state.

# 1.11.77

- The XLIFF Editor source-navigation button resolves the Xliff Generator object, element/label and property directly, even when the AL text has changed.
- Implicit default Caption entries navigate to their object/field declaration. Comments and PermissionSet object references cannot masquerade as definitions.
- Supports multiline labels, changed OptionMembers and AL enum value declarations. Ambiguous origins retain project-search fallback.

# 1.11.76

- Guided Translation adds the Expert Editor’s ¶ toggle for Source, Translation, saved target, proposal and developer notes, using a shared renderer. Draft text remains unchanged; decorations update during typing and scrolling.
- New-language workflow now starts with an explicit preparation page: selected-file Sync, optional local translation import, then guided translation and final Quality Check.
- Local import reuses Try Translation for Developer comments, exact companion .lng matches and exact glossary matches. It preserves existing staged translations and never starts AI or fuzzy matching.

# 1.11.75

- Guided Translation now walks through missing translations, review entries (including drafts and proposals), and quality issues one entry at a time.
- Reuses the Expert Editor host for edits, placeholder validation, AI suggestions, staging, saving, glossary and Quality Check.
- Shows progress, developer notes, separate suggestions, save controls and a final quality summary. Skipped edited texts remain drafts in the open XLIFF.
- Rejects stale entry actions and external document changes; late AI responses cannot overwrite a changed document.
- Dashboard icon-only actions and normal table header layout remain intact.

## 1.11.74 — 2026-10-06

- Fix dashboard column headers overlapping the first data row: remove the sticky offset inside the horizontal scroll container.
- Show Wizard and XLIFF Editor as two compact, non-wrapping icon-only buttons. Preserve tooltips, accessible names and file-specific routing.

## 1.11.73 — 2026-10-06

- Dashboard: compact Wizard and XLIFF Editor actions per XLIFF, plus conditional file-only Sync with incremental row updates.
- Guided Translation: shared start page for five workflows, selected language/file context, disabled states and existing editor/host service reuse.
- Reuse upstream VS Code wand/edit Codicons; preserve Create-XLIFF and Expert Editor workflows.
- Add 11 behavioral regressions covering multiple languages, selected-file sync, stale results, routing, concurrent refreshes and locale creation.

## 1.11.72

- Preserve existing self-closing versus explicit closing syntax for empty Notes during synchronization.
- Compare equivalent empty Note forms without false out-of-sync differences.
- Correct self-closing Note parsing so adjacent Notes are not consumed.

## 1.11.71

- Add persistent Quality sorting by rule priority, severity, entry number, rule, Source or Translation, ascending/descending.
- Use existing cancellable host paging/sort cache across all filtered results.

## 1.11.70

- Make textarea selection visible in Show non-printing characters mode using theme foreground and selection background colors.

## 1.11.69

- Enable editor Sync only for a saved document with a refreshed out-of-sync generator status.
- Invalidate confirmation on edits and reject dirty/staged or unconfirmed host Sync requests.
- Check status asynchronously with stale-result protection and genuine worker cancellation.

## 1.11.68

- Require each distinct source %number placeholder at least once in target text; allow duplicates and any order.
- Align Quality, editor validation, Apply, No State, AI and translation-import checks.

## 1.11.67

- Prioritize Developer Note mismatches in Quality reports and defer shared-target findings on those rows until the Developer suggestion is satisfied.

## 1.11.66

- Align both transfer buttons on the same horizontal center, with Developer Note directly below Proposal-to-Draft.

## 1.11.65

- Add a Developer Note transfer button beneath Proposed-to-Translation for differing local language suggestions.
- Stage exact note text including whitespace; retain proposal, draft counters and Apply/Undo flow.

## 1.11.64

- Add snapshot lookup indexes for navigation, same-source and companion resolution.
- Remove duplicate draft override text and chunk large minimal-edit comparisons with stale-document protection.
- Add repeated 5/15/30 MiB scaling runs, fixed budgets and baseline regression comparisons.
- Preserve leading/trailing Developer Note translation whitespace in Quality comparisons while retaining existing Try behavior.

## 1.11.63

- Warn when target text differs from its unambiguous local Developer Note translation for the target language.
- Support draft Quality checks and existing per-unit/project ignore rules; add configurable checkDeveloperComment setting.

## 1.11.62

- Keep the existing Quality page visible during ignore-rule refresh; reject stale rule actions until new results arrive.
- Add a webview regression for list continuity during invalidation.

## 1.11.61

- Fix Dashboard refresh referencing Sync-only controller/resources variables.
- Refresh No State counter and host filter keys immediately after bulk acceptance, without Save.
- Add real Dashboard refresh and No State host/webview regressions.

## 1.11.60

- Reuse bounded translation filter/sort indexes for page changes; reuse the numeric collator.
- Move large Apply Drafts XML batches to cancellable workers and reject stale document results.
- Yield during large draft preparation; preserve drafts and clear busy progress after failure/cancellation.
- Add cache/Apply worker regressions and tighter paging/Apply stress budgets.

# Changelog

## 1.11.59 (2026-10-05)

- Add an ordered roadmap with automated qualification and responsive Sync as the first section; retain native VS Code visual acceptance as explicitly outstanding.
- Run large editor/dashboard synchronization and dashboard Sync-status checks in the existing cancellable worker, with stale-result guards and no blocking fallback on Sync worker failure.
- Prepare pre/post-Sync translation-memory pairs in the worker and merge compact snapshots in the host.
- Add Sync equivalence/cancellation, changed-document safety, dashboard worker integration and phase-specific stress budgets.

## 1.11.58 (2026-10-05)

- Compare all visible final periods, including abbreviation dots. Accept a recognized final abbreviation expanded to text without punctuation, while retaining genuine sentence-punctuation warnings.
- Cover Import Entry Line No. → Importeintrag Zeilennr. and Importeintrag Zeilennummer, plus missing sentence periods and mismatched exclamation marks.

## 1.11.57 (2026-10-05)

- Preserve the saved target when materializing local Translation draft overrides, so Developer-note results from Try Translation/Try expose Apply and Discard row actions.
- Treat persisted Translation draft metadata as explicit staging even when draft and target text match.
- Read Apply Drafts/proposal/staged counts from the existing ordinal membership indices, clearing applied off-page drafts immediately without Save or a full-document scan.
- Add end-to-end Developer-note staging, discard and batch-apply regressions using the actual host and generated webview script.

## 1.11.56 (2026-10-05)

- Deduplicate AI inputs by exact source text before batching and reuse each validated result across all matching item keys.
- Preserve existing local-resolution and proposal staging behavior, cancellation, placeholder checks, per-unit provenance and progress counts.
- Cover cross-batch duplicates, distinct casing/whitespace, invalid placeholders, cancellation and the complete Try Translation staging path.

## 1.11.55 (2026-10-05)

- Restore Dashboard Sync all by importing its XLIFF parser; cover synchronization of an open translation and companion memory with a regression test.
- Add a No State quick filter using the same eligibility as the toolbar counter. Count saved targets rather than draft text, and reject stale eligibility flags after applying a translation.
- Move the Quality accordion above the upper translation filter bar.
- Remove C-style escape validation and escaped control characters from placeholder matching in the host and webview. Keep real parameters and actual AL line-break marker checks.

## 1.11.54 (2026-10-05)

- Terminate superseded parser/Quality workers on new runs, document changes and close; await thread exit before replacement and never fall back to a blocking scan on cancellation.
- Keep Quality findings in the extension host with bounded pages, cached severity/filter/sort indices, revision checks and page-scoped ignore/restore references.
- Add a reproducible 30,000-unit / approximately 15 MB stress fixture and real-provider integration harness, with runtime, memory, event-loop, transport and worker lifecycle measurements.
- Add event-loop maximum/p99 measurements to optional performance traces and correct Windows paths in test fixtures.

## 1.11.53

- Reduces extension-host filter/paging allocation pressure: view queries now keep only ordinal numbers in their transient match list instead of cloning all rows into a base array and allocating one `{ row, keys }` candidate object per trans-unit on every request.
- Reuses flattened per-row search/sort keys for live overrides and patches only mutable Translation/Proposal/Status fields, so page-only Notes/Glossary/Quality/Provenance detail arrays are no longer required for ordinary filtering.
- Stores only compact editor rows in the extension host. Structured Notes, Xliff Generator origin, Provenance history, Glossary hints and Quality issue objects are materialized only for the visible 50/100/200-row page.
- Keeps the page-detail glossary cache bounded to 1,000 source strings so browsing through a large XLIFF cannot gradually rebuild a second full-document glossary-detail cache.
- Updates Quality refreshes incrementally: only ordinals whose active Quality membership changed have their compact counters and flattened Quality search keys patched instead of rebuilding every row key.
- Adds a memory budget to the central DocumentSession LRU cache in addition to the existing eight-session count limit. The default budget is **384 MiB estimated parsed/cache data**; active editor sessions remain pinned while older Dashboard/Activity-Bar/background snapshots are evicted first.
- Adds `alXliffStudio.performance.documentSessionCacheMB` (64–2048 MiB, default 384) and applies changes at runtime without restarting VS Code.
- Adds regression coverage for ordinal-only host queries, page-only detail materialization, flattened override-key reuse and count+memory-bounded DocumentSession eviction.

## 1.11.52

- Replaces the webview's global full-row mirror with a sparse `rowStateIndex`: ordinary trans-units are no longer transferred or retained globally in the webview; full Source/Translation/Notes/Provenance data exists only for the currently materialized page.
- Keeps only staged/applied membership markers globally and resolves off-page staged Translation/Proposal text in the extension host from the volatile stage cache or XLIFF staging notes when Save, Apply Drafts or Quality requires it.
- Replaces linear ordinal lookup (`model.rows.find(...)`) with `Map`-based O(1) lookup and tracks dirty, proposal, applied-undo and live-override ordinals with dedicated `Set` instances.
- Changes view override collection from an O(all rows) scan to O(changed rows) and computes the override payload only once per page request.
- Updates batch Save/Apply/Discard/Quality and document-payload reconciliation to operate on sparse ordinal state without rebuilding or scanning a global webview row array.
- Removes now-unused full-row summary/index helpers from the webview and adds regression coverage for the sparse row-state and Map/Set paths.

## 1.11.51

- Keeps manual Translation/Proposal edits volatile until explicit Save or Apply, eliminating full-XLIFF staging rewrites and automatic disk saves after ordinary edits.
- Removes the full XLIFF parse from the explicit Save critical path; post-save parsing, reconciliation and Quality maintenance now run after Save has yielded back to VS Code.
- Single-row Apply now replaces only the affected `trans-unit` range instead of rebuilding/scanning the complete XLIFF.
- Extends Quality Check with `invalid-al-escape-sequence` errors for C/C#-style pseudo escapes such as `\n`, `\r`, `\r\n`, `\t`, `\xNN`, and `\uNNNN`; a plain AL backslash line break remains valid.
- Backslash pseudo escapes are no longer treated as placeholders.

## 1.11.50

- Fixes the integrated **Quality Check** panel so opening it for the first time immediately paints an already available background/cached Quality report instead of revealing an empty panel that only filled after manual Refresh.
- Shows an immediate **Quality Check running…** state when analysis is still in progress and updates the receive count while chunked Quality results arrive.
- Replaces the former full-screen/blocking XLIFF loading overlay with a **non-blocking progress strip at the top of the editor**. It has `pointer-events: none`, so loading, filtering, sorting, paging, row preparation and Apply Drafts progress no longer prevent continued interaction with the editor.
- Adds determinate percentage progress when counts are known and a subtle indeterminate running bar otherwise; the strip is delayed to **300 ms** to avoid flashing for fast operations.
- Reviews editor notifications: passive success/information messages (Sync summary, no missing translations, Try summary, unchanged AI suggestion, terminology added, etc.) now use the VS Code status bar instead of popup notifications. Confirmation prompts, actionable warnings/errors and cancellable AI progress remain intentionally visible.
- Adds regression coverage for cached Quality-panel opening, chunked Quality progress, and the non-blocking background progress strip.

## 1.11.49

- Fixes a large-XLIFF UI hang after **edit Translation → Accept draft → Save → next editor click** by removing the full Quality Check from the Save-critical path. Save now completes first and refreshes Quality asynchronously with document-version/generation stale-result guards.
- Transfers large Quality reports to the webview in **400-item chunks** instead of one large synchronous payload, yielding between chunks so the renderer remains responsive.
- Stops Quality refreshes from rescanning/updating every compact row in the webview; only currently materialized page rows are refreshed while host-side Quality membership remains authoritative.
- Lowers the default worker threshold from **8 MiB / 10,000 units** to **3 MiB / 5,000 units**, matching the editor's large-document threshold so ~5 MiB XLIFFs consistently use the off-thread path.
- Changes worker Quality processing to send the compact XLIFF source text to the worker and parse it there instead of structured-cloning the much larger parsed object graph on the extension-host thread. Draft previews are transferred as small ordinal overrides.
- Adds regression coverage for detached post-save Quality refresh, chunked Quality delivery, renderer-side row-scan avoidance, revised worker thresholds and compact draft overrides.

## 1.11.48

- Fixes host-side filtering so an absent navigation target no longer coerces `null` to ordinal `0` and incorrectly forces the first `trans-unit` into every filtered result.
- Preserves explicit navigation to ordinal `0` when the first unit is intentionally selected.
- Adds a regression test covering matching, empty-result and explicit-first-unit navigation cases.

## 1.11.47

- Implements performance roadmap **Point 10**, completing the large-XLIFF performance plan: parsing and Quality Check can now run in Node `worker_threads` for very large XLIFF files so CPU-heavy XML/QA work does not block the VS Code extension host.
- Enables worker offloading by default at **8 MiB of XLIFF text or 10,000 trans-units**. The thresholds are configurable with `alXliffStudio.performance.workerThreads.enabled`, `.minFileSizeMB`, and `.minUnits`.
- Adds an asynchronous `DocumentSession` parse path that coalesces concurrent parse requests for the same document snapshot; editor, Quality pipeline, Dashboard, Activity Bar and AL hover reuse the same completed parsed snapshot.
- Uses worker-backed parsing on initial large-file editor loads and on subsequent async reparses after document changes while retaining the existing synchronous fallback if a worker cannot start or fails.
- Runs large-file Quality analysis off-thread as well, including Quality checks that preview staged Draft/Proposal values. Structured-cloned `Map`-based Quality indices are preserved when the result returns to the extension host.
- Keeps revision/load/version checks in place so stale worker results are never applied to a newer document snapshot. Workers are one-shot and terminated after each task, avoiding persistent duplicate large-file caches in a second JavaScript heap.
- Extends performance tracing with `worker parse start/done/fallback` and `worker quality start/done/fallback` phases.
- A synthetic 5 MiB / ~19,600-unit run exercised both worker paths while a 5 ms event-loop timer continued firing throughout, confirming that the heavy work no longer monopolizes the extension-host event loop.
- Adds worker-thread, threshold, structured-clone, async-session-coalescing and editor integration regression coverage. **Performance roadmap Points 1–10 are now complete.**

## 1.11.46

- Implements performance roadmap **Point 9**: the integrated Quality Check panel now paginates findings and renders only the current **50 / 100 / 200** result page instead of creating DOM nodes for every issue at once.
- Keeps severity filtering, active/ignored views, Go navigation and local/project ignore actions working across Quality result pages while preserving the original issue index used by ignore/restore actions.
- Avoids building a full filtered Quality-result array just for paging; the editor counts matches and materializes only the findings needed for the current page.
- Caps diagnostics published to the VS Code **Problems** view at **2,000 per XLIFF file by default** while retaining the complete Quality Check result inside AL Xliff Studio.
- Adds `alXliffStudio.quality.maxProblemsDiagnostics` (100–50,000, default 2,000) so the Problems-view safety cap can be adjusted per resource.
- Records total/published/truncated diagnostic counts in performance traces without changing Quality Check totals.
- Keeps performance roadmap **Point 10 intentionally open** as the final remaining performance step.

## 1.11.45

- Implements performance roadmap **Point 8**: large XLIFF Editor loads defer the initial Quality Check until the first translation page has actually rendered.
- Treats files at or above **3 MiB of XLIFF text** or **5,000 trans-units** as deferred-quality loads; smaller files keep the existing immediate Quality Check path.
- Sends the first document/page data with a temporary empty Quality result, renders page 1, waits through two browser animation frames, and only then signals the extension host to start the cached/shared Quality pipeline in the background.
- Shows `quality pending…` in the editor summary while the deferred run is outstanding, then patches host row Quality keys, VS Code diagnostics, summary statistics and visible row Quality state when the background result arrives.
- Cancels stale deferred results by document version/load generation and lets an explicit manual Quality Check supersede a pending background run.
- Keeps performance roadmap Points **9–10 intentionally open**.

## 1.11.44

- Implements performance roadmap **Point 7**: Quality diagnostics now reuse each parsed trans-unit's `startOffset` directly instead of rescanning the entire XLIFF with a second `<trans-unit>` regex pass.
- Threads the already-cached parsed XLIFF through automatic Quality, editor load, Save, manual Quality Check, and Quality-ignore refresh paths when publishing VS Code diagnostics.
- Removes the old `findParsedTransUnitOffsets()` scanner entirely while keeping a defensive ordinal-to-offset lookup for malformed/non-indexed unit collections.
- Keeps roadmap points 8–10 intentionally open for the next incremental performance steps.

## 1.11.43

- Implements performance roadmap **Point 6**: parsed XLIFF units no longer retain a full `unit.raw` copy of every `<trans-unit>` block.
- Stores `startOffset` / `endOffset` for each trans-unit plus source/target content offsets and materializes a unit XML block only on demand through `getUnitRaw(text, unit)`.
- Updates Sync, Merge-add and XLIFF Editor Apply/Undo snapshots to use the owning document text plus offsets instead of retained raw-unit strings.
- Keeps `sourceRaw` / `targetRaw` and note-local raw XML unchanged in this step; Point 6 is deliberately limited to the large whole-unit duplication identified in the performance roadmap.
- A synthetic 5 MB XLIFF with about 12,400 units represented roughly 4.99 MB of trans-unit XML through offsets without any parsed unit owning a `raw` property.
- Adds regression coverage for exact trans-unit reconstruction, source/target content offsets, Apply/Undo round-trips and merge-add reconstruction.
- Performance roadmap Points **7–10 remain intentionally open**. In particular, diagnostics still perform their existing separate trans-unit offset scan; Point 7 will switch them to the offsets now available on parsed units.

## 1.11.42

- Implements performance roadmap **Point 5**: XLIFF Editor summary/counter values are prepared once from the extension-host row store and then maintained incrementally instead of repeatedly scanning all rows.
- Expands the central `DocumentSession` editor statistics with proposal, translation-draft, staged, placeholder-error, terminology-error, quality-issue, no-state, and applied/unsaved counters in addition to total/missing/review.
- Makes webview `updateSummary()` O(1) with respect to the total XLIFF size: it reads the maintained counters and only reconciles rows that were actually touched on the current page or by a targeted message.
- Keeps local unsaved Draft/Proposal edits accurate through per-row summary snapshots and delta updates; a document payload performs a single reconciliation pass, but ordinary UI updates no longer rescan every translation unit.
- Quality-result replacement updates the quality counter directly while synchronizing row quality membership, avoiding duplicate summary scans.
- Performance roadmap Points **6–10 remain intentionally open** for the next incremental changes.

## 1.11.41

- Implements **performance roadmap step 4/10**: precomputes normalized search, filter, sort and quick-filter keys once per prepared XLIFF row in the extension host instead of rebuilding Notes/provenance/Quality/glossary/source/translation strings on every view request.
- Adds a dedicated host-side key store for Source, effective Translation, Proposed translation, Status, Notes, trans-unit id, provenance, Quality and glossary text, plus precomputed global-search variants with and without provenance.
- Precomputes expensive Placeholder/Terminology and common quick-filter flags for unchanged rows. View requests reuse those flags directly.
- Preserves live unsaved behavior by rebuilding keys only for rows that arrive with local Translation/Proposal/status overrides; all unaffected rows continue using their prepared keys.
- Refreshes the prepared key for a row whenever the active Quality report changes so Quality and global-search results remain current.
- Normalizes the requested global/per-column filter values once per request rather than once per row.
- A synthetic 10,000-row benchmark reduced a representative repeated host query from roughly 29 ms without prepared keys to roughly 4.7 ms with the prepared key store; one-time key-store construction was about 24 ms on the test runtime.
- Adds regression coverage proving prepared Notes/Quality/glossary search keys are reused and live row overrides recompute only the affected row.
- **Performance roadmap steps 5–10 remain intentionally pending** and will be implemented separately.

## 1.11.40

- Implements **performance roadmap step 3/10**: XLIFF Editor filtering, sorting and filtered-page resolution now run in the extension host against the full host-side row store instead of running `model.rows.filter(...).sort(...)` in the webview.
- Replaces the ordinal-only `requestPageRows` protocol with `requestViewPage`: the webview sends filter controls, quick filters, sort field/direction, page size/page number and navigation target; the extension host returns only the resolved 50/100/200-entry page plus `filteredCount`, `pageCount`, range and total count.
- Preserves the existing OR semantics for quick filters (Translated/Missing/Review/Proposals/Drafts/Placeholder/Terminology/Quality), per-column filters, global search, numeric-aware sorting and Quality-Go navigation.
- Sends small live row overrides for the current page/staged rows so unsaved Translation/Proposal edits participate immediately in host-side filtering and sorting without waiting for a complete document reload.
- Removes Notes, provenance, glossary and Quality search text from the global webview index because those values are now used only by the extension-host query. The remaining compact index is retained solely for staged/edit workflow state; roadmap step 5 will address its remaining summary/count scans separately.
- Keeps asynchronous view requests load/request-aware so stale results from rapid filtering, sorting, paging or document reloads cannot replace the current page.
- Moves refreshed Quality findings into the active host-side row store so the Quality/global filters operate on the newest report.
- Adds direct regression coverage for extension-host filtering, sorting, paging, navigation, OR-combined quick filters and live overrides.
- **Performance roadmap steps 4–10 remain intentionally pending** and will be implemented separately.

## 1.11.39

- Implements **performance roadmap step 2/10**: the XLIFF Editor no longer transfers every full row object to the webview. Full row data stays in the extension host and the webview requests only the rows required for the currently visible 50/100/200-entry page.
- Sends a compact per-unit index for the existing client-side filtering, sorting, paging, staged-item counts, and summary logic, while notes, generator metadata, quality details, provenance history, max-width metadata, and other heavy row details are transferred only for the active page.
- Adds a version/load-aware page-row request protocol with stale-request rejection and request de-duplication so rapid filter, sort, page, or document changes cannot render rows from an obsolete XLIFF snapshot.
- Preserves local draft/proposal/status/provenance state when a page is discarded and later requested again by reconciling compact index state onto freshly fetched full rows.
- Keeps **roadmap step 3 intentionally pending**: filtering and sorting still run in the webview against the compact index. Steps 3–10 remain to be implemented separately.
- Adds regression coverage proving that the initial document payload contains the compact row index, page rows are requested separately, and the existing client-side filter/sort path remains in place for the next step.

## 1.11.38

- Implements **performance roadmap step 1/10**: introduces a central bounded `DocumentSession` for each XLIFF resource/content snapshot. Parsed XLIFF data, Quality analysis and reusable statistics now share one snapshot instead of being held by separate subsystem caches.
- Reuses parsed XLIFF objects across the visual editor, Quality coordinator, Dashboard, Activity Bar and AL hover index when the document content is unchanged. Editor calls with the same VS Code `TextDocument.version` skip even the content hash; same-content calls with a new version keep the parsed snapshot after hash verification.
- Moves the Quality cache into the `DocumentSession` and keeps only in-flight/revision coordination in `qualityCoordinator`, removing an additional retained source-text/parsed snapshot. Quality invalidation clears dependent session statistics without discarding a still-valid parsed XLIFF.
- Caches Dashboard/Activity Bar metrics in the same session with a Quality/config signature, while the XLIFF Editor stores its current summary statistics in the session as the basis for later paging work.
- Uses an LRU bound for non-active sessions and pins XLIFFs while a visual editor is open, preventing project scans from retaining every parsed translation file in memory or evicting the actively edited file.
- Adds regression coverage for same-version/same-content reuse, content replacement, centralized Quality/statistics invalidation, LRU eviction and active-editor pinning.
- **Performance roadmap steps 2–10 remain intentionally pending.** In particular, all rows are still sent to the webview and the existing client-side 50/100/200 pagination/filtering behavior is unchanged in this version.

## 1.11.37

- Removes `Xliff Generator` notes from the ordinary **Notes** column now that the same origin is shown directly under the `trans-unit` id in **Source**; the note remains in the XLIFF data model for sync and source navigation.
- Enlarges the per-row **⌕** source-navigation glyph without changing the row-action button dimensions or layout.
- Top-aligns all XLIFF Editor column headers so header labels and filter controls start on the same vertical baseline.
- Adds regression coverage for generator-note de-duplication in the UI and the updated row/header styling.

## 1.11.36

- Mirrors `Xliff Generator` notes from the matching `.g.xlf` during both single-file **Sync** and **Sync all XLIFFs**, alongside the existing authoritative Developer-note synchronization. Missing generator notes are added, changed notes are refreshed, and stale generator notes are removed without touching translations, review/NAB metadata, provenance, or other AL Xliff Studio notes.
- Shows the `Xliff Generator` origin directly in the XLIFF Editor Source column underneath the `trans-unit` id.
- Makes row source navigation recover a missing `Xliff Generator` note from the matching `.g.xlf` by exact `trans-unit id` before resolving the AL object/element/property hierarchy. The generator unit's current source text is used for that navigation context.
- Keeps the project-wide VS Code `*.al` search as the final fallback when neither the translation XLIFF nor its matching `.g.xlf` provides an unambiguous generator origin.
- Extends sync/source-navigation regression coverage for generator-note add/update/remove/idempotence and `.g.xlf` origin recovery.

## 1.11.35

- Normalizes all buttons in the main XLIFF Editor toolbar to the same 32 px height, including text actions, icon-only actions, the ¶ toggle, and Save.
- Vertically centers labels and icons with a shared inline-flex layout so mixed text/icon controls remain visually aligned across VS Code themes.
- Adds regression coverage for the unified toolbar button height.

## 1.11.34

- Adds a Word-style **¶ Show non-printing characters** toggle to the XLIFF Editor toolbar, positioned immediately to the right of **Quality Check** behind its own separator.
- Shows ordinary spaces (`·`), tabs (`→`), line/paragraph endings (`¶`), non-breaking spaces (`⍽`), zero-width characters, and soft hyphens as visual-only markers in **Source**, **Translation**, **Proposed translation**, and `Developer` notes.
- Keeps the underlying XLIFF text unchanged: Translation/Proposal text areas use a synchronized visual overlay, while Source/Developer-note markers are CSS decorations, so editing, copying, Quality Check, staging, and saving continue to use the real characters.
- Synchronizes marker overlays while typing and scrolling in Translation/Proposal editors and preserves the toggle state across paging/filtering within the retained webview state.
- Adds regression coverage for toolbar placement, toggle persistence, marker rendering, Developer-note scoping, and generated webview syntax.

## 1.11.33

- Reworks the per-row **⌕** AL source navigation to use the structured `Xliff Generator` origin as the primary locator instead of globally ranking identical source-text matches.
- Resolves the exact AL object first, then validates the generator hierarchy (`Field`, `Action`, `Control`, `Change`, `ReportDataItem`, `EnumValue`, `Method`, `NamedType`) and final `Property` before opening the definition.
- Handles object names that themselves contain ` - ` without mis-parsing the generator path and supports generator-named properties such as `EntityCaption`, `EntitySetCaption`, and `RequestFilterHeading`.
- Keeps structural `OptionMembers`/list matching, so compiler XLIFF text such as `[ ,Freigegeben,Gesperrt]` resolves to `OptionMembers = " ",Freigegeben,Gesperrt;` inside the exact field.
- Removes the ambiguous AL-definition picker. If the generator origin is missing, stale, duplicated, or otherwise not uniquely resolvable, opens VS Code's project-wide Search view prefilled with a useful source query and restricted to AL files in the current project.
- Adds regression coverage for duplicate source text across objects/fields, Method + NamedType resolution, PageExtension `Change`, hyphenated object names, arbitrary generator properties, OptionMembers, and fallback-search query generation.

## 1.11.32

- Fixes the row **? Try** workflow getting stuck on `Rendering page … 0 / N entries` after an unsaved `translated` → `needs-translation` status change.
- Removes the unnecessary full-document reload after a single-row deterministic/fuzzy Try result; the persisted draft/proposal is now reconciled directly into the affected row.
- Makes page-render loading overlays generation-aware so a lightweight render that supersedes an already-started chunked render also closes the older render overlay.
- Keeps the existing in-memory unsaved-status workflow: users do not need to save `needs-translation` before requesting a fresh translation.

## 1.11.31

- Makes per-row **? Try** work directly against the newest in-memory XLIFF document after an unsaved workflow-state change such as `translated` → `needs-translation`; no intermediate file Save is required.
- Serializes row Try behind pending XLIFF document mutations, reparses `document.getText()` immediately before resolution, and validates trans-unit id/source before staging a result.
- Keeps **? Try** and row AI disabled only while the status mutation itself is still being committed, then enables them from the confirmed `statusUpdated` document version.
- Treats a non-empty `needs-translation` target as an explicit retranslation request: Developer-comment, exact `.lng`, exact glossary, and fuzzy candidates identical to the current target are skipped so resolution can continue to a genuinely changed suggestion or AI.
- Does not stage an AI proposal when the model returns exactly the current target text, and revalidates the unit after the AI request before persisting the proposal.
- Adds regression coverage for unsaved status-to-Try sequencing, unit identity validation, changed Developer-note retry, unchanged-known-result skipping, and row status busy state.

## 1.11.30

- Extends **⇄ Sync** and **Sync all XLIFFs** so existing translation units also mirror their `from="Developer"` notes from the matching generated `.g.xlf`.
- Treats the generated Developer-note set as authoritative per trans-unit: changed/new Developer notes are copied and stale Developer notes are removed when they disappear from the `.g.xlf`.
- Preserves targets and all unrelated notes/metadata, including `Xliff Generator`, `AL.XliffStudio`, review, NAB, and provenance notes.
- Reports the number of synchronized Developer-note sets in single-file and project-wide Sync results and synchronization-state details.
- Adds regression coverage for Developer-note updates, removal, preservation of unrelated notes, multiple Developer notes, and idempotent re-sync.

## 1.11.29

- Aligns the per-row **←** Proposed → Translation draft transfer button to the top of the row instead of vertically centering it beside taller text areas.
- Extends AL source navigation for compiler-generated list sources such as XLIFF `[ ,Freigegeben,Gesperrt]` so the row search action resolves the corresponding `OptionMembers = " ",Freigegeben,Gesperrt;` assignment.
- Uses the `Xliff Generator` property hint for bracketed list sources, supports quoted identifiers and multiline assignments, and keeps exact Label/Caption/ToolTip navigation unchanged.
- Selects the complete matching AL list value even when the assignment spans multiple lines.
- Adds regression coverage for single-line/multiline `OptionMembers`, mismatching lists, and top-aligned proposal transfer controls.

## 1.11.28

- Makes translation-unit navigation highlights severity-aware: Warning jumps use the same yellow VS Code warning colour as row markers, Error jumps use red, and Info jumps use VS Code blue; navigation without a Quality severity remains green.
- Applies the selected severity colour consistently to both the full-row background tint and outline while retaining the 5.2-second highlight duration.
- Carries Quality severity through both the in-editor Quality Check **Go** action and the optional Problems Quick Fix navigation, including jumps queued while the custom editor is still opening.
- Adds regression coverage for severity propagation and the theme-aware navigation highlight colours.

## 1.11.27

- Makes explicit XLIFF row navigation visually clearer: the target row now gets a subtle green full-row background in addition to the existing green outline.
- Keeps the target-row highlight visible for 5.2 seconds so Quality Check **Go**, Problems Quick Fix navigation, AL-source navigation, and other row jumps remain easy to locate.
- Restarts the highlight timer when the same row is revealed again, guaranteeing the full highlight duration from the latest navigation action.
- Adds regression coverage for the full-row highlight styling and minimum five-second duration.

## 1.11.26

- Fixes the remaining per-row **✓ Apply** race where an already-started editor reload could reintroduce a just-applied Translation draft and make the ✓ button appear again until a second click or Save.
- Binds every `postDocument()` preparation to the exact VS Code `TextDocument.version` captured with its XLIFF snapshot. If the document changes while parsing, Quality Check, row preparation, or webview transfer is in flight, that stale payload is cancelled instead of updating the editor.
- Sends document versions with Save-state and row-Apply acknowledgements; the webview rejects older document payloads even if they were already queued for delivery.
- Adds a defensive applied-row reconciliation invariant: a row marked **applied · unsaved** can never be reconstructed as an active Translation draft by an in-flight payload, so ✓ stays hidden while ↶ Undo Apply remains available until Save.
- Adds monotonic webview edit revisions for Translation drafts and ignores late `translationDraftChanged` messages that belong to the revision already committed by row Apply. This prevents a blur/change message already in flight from recreating the staging note after Apply.
- Extends regression coverage for stale document snapshots, stale webview payloads, and late draft-persistence messages.

## 1.11.25

- Adds an API-safe VS Code **Problems Quick Fix** named **AL Xliff Studio: Show translation unit**. It does not intercept ordinary Problems clicks and does not install any text-selection/document bridge, so the row `</>` raw-XLIFF action remains completely independent.
- Stores a private navigation target at the moment each AL Xliff Studio `Diagnostic` is created: XLIFF URI/range key plus Quality code, severity, `trans-unit` id, source text, and ordinal. Quick Fix lookup uses both Diagnostic object identity and a stable URI/range/code/message key so it remains reliable when VS Code supplies an equivalent Diagnostic instance.
- Resolves a Quick Fix target defensively against the current XLIFF: stable `trans-unit` id first, source-qualified duplicate-id resolution, identity-checked ordinal fallback, then unique-source fallback. Stale findings never jump to an unrelated row.
- Adds `alXliffStudio.quality.problemsNavigation.enabled` (default `true`). Disabling it removes the Quick Fix/navigation behavior while leaving ordinary Quality diagnostics in Problems unchanged; Diagnostic navigation mappings are not populated while disabled.
- Adds regression coverage for stored Diagnostic mappings, cloned-Diagnostic lookup, setting-based disabling, command routing, and continued absence of the old Problems click/selection bridge.

## 1.11.24

- Removes the experimental VS Code **Problems → visual XLIFF row** navigation bridge completely. Quality diagnostics are published on the real `.xlf` resource again, with no text-selection listeners, virtual document provider, redirect tab, or Problems-specific row filtering.
- Restores the row **</>** action and the top raw-XLIFF action to a direct normal text-editor path. The row action opens the XLIFF source, selects the exact `trans-unit`, and keeps that source editor open.
- Changes project/global Quality Ignore from an exact-finding suppression to a **rule-wide project suppression**. Ignoring a Quality code now suppresses every finding of that rule across all XLIFFs and target languages in the AL project.
- Simplifies `.alxliffstudio/quality-ignores.json` to version 2 rule entries containing only the Quality `code`; existing version-1 exact-finding entries are read as rule-level ignores and deduplicated automatically.
- Uses a globe-with-slash icon for **Ignore rule globally** and a plain globe without a slash for **Restore globally ignored rule**. The global action remains directly to the right of the local ignore control.
- Adds regression coverage for removal of the Problems bridge, raw-XLIFF row navigation, rule-wide suppression/migration, and the distinct ignore/restore globe icons.

## 1.11.23

- Keeps the row **</> raw XLIFF** action open reliably: automatic VS Code Problems navigation now reacts **only** to the dedicated internal Problems bridge URI and never to selections in the real `.xlf` text editor, including non-empty `trans-unit` selections.
- Removes raw `.xlf` URIs from the Problems target map so ordinary source-editor cursor/selection changes cannot be mistaken for diagnostic navigation while retaining Problems-to-visual-editor jumps through the isolated bridge.
- Replaces the project/global Quality Ignore graphic with a stroke-only globe/slash SVG that follows the VS Code foreground colour instead of rendering as a black filled circle.
- Groups local and project Quality Ignore controls so the project/global button is always directly **to the right** of the local `⊘` button.
- Adds regression coverage for non-empty raw-XLIFF selections and the project-ignore icon/layout.

## 1.11.22

- Fixes per-row **✓ Apply** so the accepted Translation draft immediately leaves draft/apply state after the first click; the row controls are updated in place without waiting for a second click or a full editor reload.
- Keeps a row-level **↶ Undo Apply** action available after an applied translation while the XLIFF document is still unsaved. Undo restores the exact previous `trans-unit` XML and, when the applied value came from a Translation draft, re-stages that draft with its provenance. A real document Save commits the operation and removes the temporary Undo state.
- Gives batch **✓ Apply Drafts** the same pre-save row-level Undo semantics, while blocking structural workflows such as Sync until pending applied translations are either saved or undone.
- Adds project-wide Quality Check ignores for **Errors, Warnings, and Infos** without adding suppression metadata to the XLIFF. Exact finding signatures are stored in `.alxliffstudio/quality-ignores.json`, which is intentionally left versionable for project/team use.
- Adds a dedicated monochrome globe/slash action beside the existing per-unit `⊘` ignore action. The existing **Ignored** view now includes project-wide suppressions and lets the same globe/slash action restore them.
- Makes automatic Quality Check watch `quality-ignores.json`, invalidate the shared Quality cache, and refresh project diagnostics when project-level exceptions are added, removed, or edited externally.
- Adds regression coverage for immediate row-Apply state, pre-save Undo, exact project-ignore matching/storage, Error suppression, project file placement, UI restore actions, and background Quality invalidation.

## 1.11.21

- Makes VS Code **Problems** navigation reliable while the visual XLIFF editor remains the default `*.xlf` editor. Quality diagnostics are exposed through an internal read-only range-preserving navigation document, so a Problems click retains the exact diagnostic location before switching to the custom editor.
- Clicking an AL Xliff Studio Error, Warning, or Info in **Problems** now opens/reuses the visual XLIFF Editor, switches to the correct paginated page, centers the matching translation unit, and highlights it. The short-lived internal navigation tab is closed automatically.
- Resolves stale Problem targets defensively: ordinal first, then exact `trans-unit` id, then unique source text. If none can be resolved after an external/synchronization change, the editor clears conflicting filters and narrows the existing filter fields to the diagnostic id/source instead of silently opening page 1.
- File-level structural Problems that do not belong to one `trans-unit` still return to the visual editor and open the Quality panel instead of leaving an internal navigation document visible.
- Keeps raw-XLIFF editing safe: an ordinary collapsed caret in the XML source is never treated as a Problems navigation request.
- Adds regression coverage for range/caret Problems navigation, the read-only bridge, stale-target fallback filtering, and raw-editor isolation.

## 1.11.20

- Fixes the severe Quality Problems performance regression on large XLIFFs: diagnostic offsets now use one line-start index plus binary lookup instead of repeatedly slicing and splitting the complete document for every issue. Diagnostic ranges are cached per translation-unit offset.
- Adds a shared Quality analysis coordinator for the XLIFF Editor, automatic background checks, Translation Dashboard, and Activity Bar. Identical analyses are cached and concurrent requests for the same document/configuration share one in-flight run.
- Prevents stale Quality runs from replacing diagnostics after a newer XLIFF document revision has superseded them. Internal editor mutations invalidate old analysis snapshots immediately.
- Makes ordinary Save reuse the shared Quality pipeline, so Save, `onDidSaveTextDocument`, file-watcher events, Dashboard and Activity Bar do not repeatedly parse/analyze the same XLIFF state.
- Updates Activity Bar and Translation Dashboard incrementally when an existing translation XLIFF is saved; project-wide rescans remain for file-set, app.json, glossary, configuration, and workspace changes.
- Adds detailed diagnostics timing checkpoints for trans-unit offset discovery, line-index creation, Diagnostic object creation, and `DiagnosticCollection.set`.
- Fixes performance-log event ordering: sequence number, timestamp, and memory are captured synchronously at the event and queued in invocation order instead of after asynchronous filesystem setup.
- Splits bulk **✓ No State** tracing into preparation, confirmation wait, XLIFF application, language-map update, and webview update so user confirmation time is distinguishable from computation time.
- Adds regression coverage for shared Quality caching, stale-run protection wiring, incremental Dashboard/Activity updates, deterministic performance logging, and the linear-time diagnostic position algorithm.

## 1.11.19

- Added opt-in performance diagnostics via `alXliffStudio.debug.performance.enabled`.
- Added configurable slow-operation threshold (`alXliffStudio.debug.performance.slowThresholdMs`, default 250 ms).
- Added `.alxliffstudio/debug/performance.log` with correlated traces for XLIFF loading, parsing, glossary loading, Quality Check, row preparation, Save, staged-note persistence, Apply Drafts, editor messages and webview rendering.
- Long-running operations emit periodic `STILL-RUNNING` records including their last completed phase, document metadata and extension-host memory usage.
- Added `AL Xliff Studio: Open Performance Debug Log`; the Activity Bar exposes the log while performance debugging is enabled.
- Performance logs rotate at approximately 5 MB to keep debug data bounded.

## 1.11.18

- Makes **Save** a lightweight commit path: saving no longer rebuilds the complete XLIFF editor row model and therefore does not enter the expensive `Preparing rows` stage for an ordinary save.
- Batches any still-pending Draft/Proposal staging notes into the explicit Save operation, eliminating the blur-persistence vs. Save race that could trigger duplicate document changes/reloads.
- Suppresses save-participant document changes while the explicit Save is active and reconciles non-structural target/state changes back into the current editor rows in place.
- Falls back to a full row reload only when a save participant actually adds/removes/reorders translation units or changes their source structure.
- Debounces external XLIFF document-change reloads so formatter/source-control/other-extension bursts collapse into one preparation pass instead of repeatedly restarting large-file row preparation.
- Keeps the requested Save-time Quality Check refresh, including staged Drafts/Proposals, without forcing the Quality panel open.
- Adds regression coverage for the lightweight Save path and serialized staging persistence.

## 1.11.17

- Reworks the XLIFF Editor draft commit path around one deterministic document-mutation queue, preventing persisted staging-note writes from racing with row **✓** or **✓ Apply Drafts**.
- Changes **✓ Apply Drafts** to commit **Translation drafts only**. Proposal drafts must first be reviewed and moved through **←** / **← Proposals to Drafts**, matching the toolbar workflow and preventing unreviewed AI/fuzzy proposals from being accepted implicitly.
- Applies any number of Translation drafts in a **single XLIFF pass** instead of reparsing/rebuilding the entire file once per draft. On the supplied 1.1 MB / 1,439-unit XLIFF, a 200-draft synthetic commit drops from about 9.4 s of XML processing to about 52 ms.
- Removes the full `Preparing rows` document rebuild after Apply Drafts, including large batches. The existing in-memory rows are updated immediately and Quality Check refreshes asynchronously.
- Makes per-row **✓** responsive immediately: the row shows a busy state, the XLIFF commit updates the row first, and companion `.lng` maintenance no longer blocks the visual acknowledgement.
- Makes simple Status changes incremental instead of rebuilding the entire editor; Quality diagnostics refresh asynchronously afterwards.
- Keeps delayed loading overlays only for genuinely larger Apply Drafts operations; fast batch commits complete without a flash.
- Adds batch-update regression coverage and verifies that unapplied Proposal drafts remain staged when Translation drafts are committed.

## 1.11.16

- Reworks Quality Check **Go** navigation into a deterministic render-and-jump path: page changes complete first, then the target row owns the translation viewport and becomes the persisted scroll position. Stale scroll restores can no longer pull the view back to the top or the previous position.
- Makes VS Code **Problems** navigation independent of `TextEditorSelectionChangeKind`; a non-empty diagnostic range is matched directly to its translation-unit ordinal and routed into the visual XLIFF Editor. Jumps that arrive while the custom editor is still loading are queued until the row model exists.
- Hardens large-XLIFF loading by cancelling stale overlapping document preparations and by suppressing internal XLIFF edits using document versions instead of a fragile one-shot change flag.
- Adds an explicit **Updating editor** loading stage so a large webview payload is no longer misleadingly shown as stuck on `Preparing rows`.
- Optimizes glossary-heavy projects: normalized language entries and word-match regexes are cached, applicable glossary terms are resolved once per unique source, and row payloads contain only the glossary/quality fields the webview actually needs.
- Reduces unnecessary full reloads after internal edits, addressing the intermittent `Preparing rows` stall seen after applying/accepting a small number of drafts.

## 1.11.15

- Clicking an **AL Xliff Studio** diagnostic in the VS Code Problems view now routes command-style diagnostic navigation into the visual XLIFF Editor and jumps to the matching translation unit.
- Stores the translation-unit ordinal alongside published diagnostics so Problems navigation does not need to guess from source text.
- Optimizes **Apply Drafts** for small batches: applying only a few drafts no longer rebuilds every row of a large XLIFF or shows the expensive `Preparing rows` phase.
- Small Apply Drafts operations update row state and Quality Check diagnostics incrementally; the existing full reload/progress path remains for larger batches.

## 1.11.14

- Adds **Info**, **Warning**, and **Error** severity filters directly to the Quality Check result list.
- Severity filters are OR-combined: selecting Warning + Error shows issues of either severity; with no severity selected, all Quality Check results are shown.
- Keeps active and ignored Quality Check views filterable with the same controls and shows the filtered result count without changing the overall issue summary.

## 1.11.13

- Fixed Quality Check **Go** navigation so an explicit jump remains at the target row instead of being overwritten by a queued scroll-position restore.
- The target position is now persisted as the new editor scroll position.
- If the target row is already rendered, **Go** scrolls directly to it without rebuilding the translation table.

## 1.11.12

- Fixes final-punctuation QA for single-letter codes/designators such as `H.`: a lone letter before a final period is no longer assumed to be an abbreviation.
- Keeps known abbreviations and multi-part dotted forms such as `No.`, `Nr.`, `z. B.`, `u. a.`, and `U.S.` abbreviation-aware.
- Adds a regression test for `rMQR supports error correction levels M and H only.` → `rMQR understøtter kun fejlkorrektionsniveauer M og H.`.

## 1.11.11

- Keeps manual Translation and Proposal text editing entirely local while a row text editor has focus; backing XLIFF staging metadata is not written or auto-saved during active typing.
- Defers full XLIFF table rerenders while a Translation/Proposal textarea owns focus, preventing async refreshes or external document updates from stealing the caret.
- Flushes pending staged metadata and any deferred render only after focus leaves the row text editors; moving directly from one Translation/Proposal field to another keeps editing uninterrupted.
- Preserves the existing explicit Apply Drafts workflow: leaving a text editor persists only staging metadata, never promotes the draft to a translated target.

## 1.11.10

- Expands Quality Check with accidental repeated-space/tab detection, placeholder-order warnings, formatting/escape-sequence validation, conservative strong length-deviation warnings, and stale/malformed NAB residue detection.
- Separates parameter placeholders from formatting escapes so missing `%1`/`#1`/brace placeholders remain hard errors while line breaks, backslashes, `\n`, `\r`, and `\t` get a dedicated structural diagnostic.
- Makes final-punctuation validation bidirectional: it now detects punctuation added in the target as well as punctuation missing from it.
- Treats periods belonging to abbreviations as lexical content rather than sentence punctuation, including common English/German UI abbreviations, initials, and dotted forms such as `z. B.`, `u. a.`, and `U.S.`.
- Adds individual settings for the new Quality Check categories; all new checks are enabled by default and warning-level findings remain suppressible through the existing Quality Ignore workflow.

## 1.11.9

- Makes XLIFF Editor loading overlays adaptive: they are now reserved for larger XLIFF views and larger Apply Drafts batches instead of appearing for routine actions.
- Delays blocking loading overlays briefly so fast operations complete without a visible flash.
- Renders small and medium pages atomically, avoiding the clear-and-rebuild flicker during filtering, sorting, paging, and row workflow updates.
- Debounces text-filter input slightly to prevent repeated rerenders while typing; checkbox filters remain immediate.
- Updates Try Translation busy controls in place instead of rebuilding the complete table.
- Shows Apply Drafts progress only for batches of 20 or more staged translations and throttles progress events for large batches.
- Keeps the Apply Drafts overlay stable through the final document reload and stabilizes workflow button widths to reduce toolbar layout shifts.

## 1.11.8

- Preserves the current XLIFF Editor scroll position across all row actions and asynchronous row refreshes.
- Persists the table scroll offset in the webview state so reopening/reloading the retained editor view restores the previous position.
- Sorting, filtering, paging and explicit jump-to-unit navigation still intentionally move to the beginning/target of the requested view.

## 1.11.7

- Opens the Translation Dashboard automatically when the AL Xliff Studio Activity Bar container becomes visible, while keeping the new Languages/Tools/Project navigator open on the left.
- Refreshes XLIFF Quality Check diagnostics/report immediately after a successful blue **Save**, including persisted staged drafts as their effective would-be translations without applying them.
- Preserves the Quality Check panel's current visible/hidden state during the automatic save refresh.
- Adds a blocking **Applying drafts** loading overlay with processed/total draft progress for **✓ Apply Drafts**, preventing the editor from appearing frozen during larger batch commits.

## 1.11.6

- Persists uncommitted Translation drafts and Proposal drafts directly in their XLIFF trans-units as standard `AL.XliffStudio` `<note>` metadata, so AI results and manual staging survive editor/VS Code restarts without becoming real target translations.
- Restores persisted drafts/proposals automatically when the visual XLIFF editor is reopened, including origin/provenance information.
- Keeps staged metadata out of the ordinary Notes column, translation memory, translated counts, and target workflow state until the user explicitly applies it.
- Removes staging notes when drafts are applied or discarded; invalidates staged metadata automatically when synchronization changes the underlying source text.
- Auto-saves staging-only metadata when the XLIFF was otherwise clean, while deliberately avoiding auto-saving unrelated dirty document edits.
- Serializes staging writes and debounces manual editing persistence to avoid stale AI/draft metadata during rapid edits.

## 1.11.5

- Turns the AL Xliff Studio Activity Bar view into a compact project navigator instead of an automatic Dashboard launcher.
- Adds expandable **Languages**, **Tools**, and **Project** sections.
- Shows each translation locale with concise Missing/Review/Quality status and opens the XLIFF Editor directly on click.
- Shows `supportedLocales` without an XLIFF as **Not created** entries and allows one-click XLIFF generation from the matching `.g.xlf`.
- Adds quick actions for Translation Dashboard, Glossary, AI Usage, Sync all XLIFFs, project-wide Quality Check, and Refresh.
- Adds project shortcuts for `app.json`, generated `.g.xlf`, `.alxliffstudio`, Translation Memory, Glossary, and the AI Debug Log when debug mode is enabled.
- Adds an Activity Bar badge with the aggregate number of missing translations, review items, quality issues, missing locale XLIFFs, and parse errors.
- Refreshes the Activity Bar overview when XLIFFs, `app.json`, glossary/configuration, or workspace folders change.

## 1.11.4

- Compares each AL project `app.json` `supportedLocales` entry with the translation XLIFFs shown in the Translation Dashboard.
- Shows supported target locales that do not yet have an XLIFF as dedicated **Not created** rows instead of silently omitting them.
- Adds **Generate XLIFF** for a missing supported locale when one unambiguous `Translations/*.g.xlf` is available. The generated file is named `<generator-base>.<locale>.xlf`, sets `target-language`, preserves generator notes/context, and creates empty `state="needs-translation"` targets.
- Never offers generation for the `.g.xlf` source language and never overwrites an existing translation XLIFF.
- Shows a disabled-generation hint when `supportedLocales` contains a missing locale but no unambiguous `.g.xlf` exists yet.
- Refreshes the Dashboard when `app.json` is saved and adds a summary count for locales that are still missing an XLIFF.
- Adds regression coverage for `supportedLocales` parsing, filename derivation, safe XLIFF creation, source-language protection, and Dashboard generation wiring.

## 1.11.3

- Filters **AL Xliff Studio: Select Translation AI Model** so providers known to be incompatible with VS Code text responses are no longer offered; `copilotcli` models are excluded.
- Deduplicates identical logical models across providers and prefers the standard `copilot` provider.
- Applies the same compatibility guard when resolving the saved model configuration, so a stale `copilotcli` selection is redirected to a compatible provider exposing the same model when available.
- Stores model id, vendor, and family together when a model is selected to avoid stale family/vendor combinations.
- Adds regression coverage for picker filtering, provider preference, and stale incompatible model settings.

## 1.11.2

- Adds `alXliffStudio.debug.enabled` (default `false`) for opt-in persistent AI request/response diagnostics.
- Writes the exact AI translation prompt, raw model response, model metadata, unit/context payload, parser result, and request/parse errors to `.alxliffstudio/debug/ai-debug.log`.
- Adds **AL Xliff Studio: Open AI Debug Log** to open the project-local debug file directly from the Command Palette.
- Appends the debug-log location to XLIFF editor parse errors while debug mode is enabled, making unsupported GPT-5.6 Luna response shapes inspectable without reproducing them elsewhere.
- Keeps the debug directory out of Git by maintaining `debug/` in `.alxliffstudio/.gitignore`.

## 1.11.1

- Makes AI translation tolerant of compact-model/Luna responses that use alternate JSON field names, one-based ids, Markdown tables, numbered/bulleted translation lists, or a bare translation for a single item.
- Automatically retries malformed/incomplete batched AI responses in smaller batches instead of failing the complete translation run.
- Removes the unreleased obsolete Dashboard AI-usage compatibility setting; AI usage collection is controlled only by `alXliffStudio.ai.usage.enabled`.


## 1.11.0

- Moves AI usage out of the Translation Dashboard into a dedicated **AI Usage** overview opened from a new Dashboard button.
- Adds persistent per-project AI usage history in `.alxliffstudio/ai-usage.json` so request/token statistics survive VS Code and Extension Host restarts.
- Expands AI Usage with all-time and current-session totals, model breakdown, language-pair breakdown, daily statistics, per-project totals, and recent request history, plus Data/Refresh/Reset actions.
- Adds `alXliffStudio.ai.usage.enabled` (default `true`) to disable future usage collection while keeping existing statistics readable.
- Introduces a project-local `.alxliffstudio` directory beside the nearest `app.json` instead of placing extension data under `.vscode`. This keeps tool data separate from editor configuration and supports multi-app workspaces cleanly.
- Moves companion translation-memory files from `Translations/*.lng` to `.alxliffstudio/lng/*.lng`; legacy maps are migrated automatically and existing confirmed translations are preserved.
- Moves the default terminology glossary to `.alxliffstudio/glossary.json` and migrates an unambiguous legacy `.al-xliff-glossary.json`; explicitly configured glossary paths remain supported.
- Creates `.alxliffstudio/.gitignore` with `ai-usage.json`, keeping persistent usage telemetry local while allowing the glossary and `.lng` translation memory to be version-controlled.
- Adds regression coverage for the new project-data layout, migration paths, persistent usage aggregation, and dedicated AI Usage page.

## 1.10.9

- Makes VS Code language-model response parsing tolerant of compact-model output such as a single JSON object, `translations`/`results` wrappers, keyed `t0` objects, JSON Lines, and JSON embedded in short prose/code fences while keeping strict ID-to-unit mapping.
- Strengthens the AI prompt so models are explicitly asked to return a bare JSON array with `[` as the first and `]` as the last character.
- Fixes GPT-5.6 Luna translation attempts that previously failed with `AI response did not contain a JSON array.` when the model returned a valid translation in a different JSON envelope.
- Adds a dismiss button to the XLIFF editor error banner so AI/model errors can be closed without reloading the editor.
- Adds regression coverage for compact-model response shapes and the dismissible error banner.

## 1.10.8

- Makes the Translation Dashboard **AI usage** panel collapsible and remembers its collapsed/expanded state inside the dashboard webview.
- Fixes the XLIFF editor AI progress notification so percentage increments are based only on newly completed translations instead of repeatedly adding the cumulative completed count.
- Prevents the AI progress bar from reaching 100% before all translation batches have actually completed.
- Adds regression coverage for collapsible AI usage and delta-based AI progress reporting.

## 1.10.7

- Adds current-session AI usage to the Translation Dashboard only: requests, input tokens, output tokens, total tokens, and used model metadata.
- Counts prompt and response tokens with the selected VS Code language model's `countTokens(...)` API for each AI batch and updates an open Dashboard live.
- Keeps token usage out of XLIFF rows/editor lines and labels the values as session tokenizer counts rather than provider billing usage.

## 1.10.6

- Adds explicit interoperability with NAB AL Tools when `NAB.UseTargetStates` is disabled and NAB stores workflow state as `[NAB: ...]` text prefixes.
- Treats `[NAB: REVIEW]` and `[NAB: SUGGESTION]` as review metadata and `[NAB: NOT TRANSLATED]` as missing instead of exposing those markers as translation text.
- Prevents all NAB-prefixed targets from entering companion `.lng` translation memory until they have been explicitly resolved/accepted.
- Migrates a NAB-tagged row to normal XLIFF state semantics when AL Xliff Studio fills, edits, accepts, merges, or source-synchronizes it, removing the textual marker and stale `note from="NAB AL Tools"` while preserving unrelated notes.
- Keeps Dashboard metrics, Quality Check, AI context, and editor status classification consistent for both NAB marker mode and NAB target-state mode.
- Adds regression coverage for all three NAB markers, translation-memory exclusion, acceptance/fill cleanup, quality metrics, source synchronization, and merge behavior.

## 1.10.5

- Changes the row **⌕** action from opening VS Code Search to direct AL source navigation for the current XLIFF unit.
- Resolves `Label`, `Caption`, `ToolTip`, and other translatable AL string definitions by exact source text and ranks duplicate matches with `Xliff Generator` object/element/property context.
- Shows a compact source-definition picker only when multiple AL locations remain equally plausible; the Search view is no longer opened.
- Adds a per-row **</>** action beside **T+** that opens the raw XLIFF text editor and selects the current `trans-unit`.
- Adds regression coverage for direct AL source resolution, NamedType labels, escaped apostrophes, duplicate-context ranking, and raw XLIFF unit navigation.

## 1.10.4

- Makes the matching `.g.xlf` authoritative for the set of translation units during **Sync** and **Sync all XLIFFs**.
- Removes translation units from language XLIFFs when their IDs no longer exist in the `.g.xlf`, covering deleted AL texts and entries omitted after `Locked = true`.
- Preserves confirmed translations from the pre-sync XLIFF in the companion `.lng` before obsolete units are removed, so those translations remain available as translation memory.
- Updates Dashboard sync details and synchronization summaries to report obsolete units that will be/are removed.
- Adds regression coverage for obsolete-unit removal, generator ordering after removal, and `.lng` retention of translations from removed units.

## 1.10.3

- Grouped the XLIFF editor toolbar into workflow-oriented sections separated by vertical dividers.
- Preserved the existing button icons and workflow order: Sync → Try Translation → Proposals to Drafts → Apply Drafts → Discard Drafts | No State → Quality Check | Dashboard → Glossary → Refresh → raw XML | Save.
- Moved the blue Save action to the end of the toolbar while retaining its dirty-document-only enablement.
- Kept each workflow section together as a flex group so responsive wrapping occurs between logical groups rather than between individual buttons where possible.

## 1.10.2

- Added a dedicated **AL Xliff Studio** icon to the VS Code Activity Bar.
- Selecting the Activity Bar entry opens the existing project-wide Translation Dashboard directly.
- Added a matching dashboard launcher item in the sidebar so the dashboard can be reopened while the AL Xliff Studio container is already active.
- Uses a bundled theme-compatible SVG icon instead of a font glyph.

## 1.10.1

- Added a blue **Save** button to the visual XLIFF editor. It is enabled only while the underlying XLIFF document has unsaved changes and saves the file without applying staged Translation/Proposal drafts.
- The Save state follows edits made by editor actions as well as external/raw-editor changes and resets immediately after a successful save.
- Replaced the font-dependent Translation Dashboard glyph in the XLIFF editor toolbar with an inline SVG dashboard icon so it renders reliably instead of appearing as a white square.
- Added regression coverage for Save-button dirty-state wiring and the dashboard SVG icon.

## 1.10.0

- Added **⇄ Sync all XLIFFs** to the Translation Dashboard to synchronize every translation XLIFF against its matching `.g.xlf` in one pass.
- Added a **Sync** column with **Synced**, **Out of sync**, **No .g.xlf**, and **Error** states per translation file.
- Dashboard sync-state detection uses the same non-destructive synchronization routine as the visual XLIFF editor, including source changes, missing units, generator order, and retained obsolete units.
- Project-wide synchronization also refreshes companion `.lng` translation-memory files from pre-sync and synchronized XLIFF content.
- Added regression coverage for dashboard synchronization wiring/status rendering and synchronization idempotence.

## 1.9.0

- Added persistent Quality Check ignore/restore workflow for Warning and Info issues.
- Added a separate **Ignored** view in the Quality accordion; ignored issues are excluded from normal Problems diagnostics.
- Quality ignores are source/target-specific, so changed translations automatically re-enable previously suppressed checks.
- Added glossary-level `quality.ignore` exceptions and a **Quality exceptions** column in the visual glossary editor.
- Improved punctuation QA to recognize common English UI abbreviations such as `No.`, preventing false positives like `Customer No.` → `Debitornummer`.
- Quality errors such as placeholder mismatches remain non-ignorable.

## 1.8.0

- Adds **AL translation hover** for Business Central `.al` source files. Hover `Caption`, `ToolTip`, `InstructionalText`, `OptionCaption`, other supported translatable properties, or Label literals to see translations for every detected target language.
- Adds a clickable language link in the hover that opens the matching XLIFF directly in the AL Xliff Studio visual editor and jumps to the corresponding `trans-unit`, including the correct paginated page.
- Resolves duplicate English source texts contextually using the generated `.g.xlf`, `Xliff Generator` notes, AL object name/type, field/action/control context, and property type; then follows the resolved trans-unit id across language files.
- Shows missing targets and current XLIFF target states in the hover.
- Adds a cached project translation index with automatic invalidation when XLIFF files or relevant settings change.
- Adds `alXliffStudio.hover.enabled` (default `true`) and `onLanguage:al` activation.
- Adds regression coverage for AL string parsing, escaped quotes, object/field context matching, duplicate-source disambiguation, and direct XLIFF navigation wiring.

## 1.7.3

- Adds a top-level **✓ No State** action to the visual XLIFF editor for confirming all existing non-empty targets without a `state` attribute in one operation.
- Shows a mandatory modal safety confirmation with the exact number of translations that will be changed before writing anything.
- Sets eligible `(no state)` targets to `state="translated"` without changing their translation text and updates the companion `.lng` translation memory.
- Skips `translate="no"`, empty targets, already-stateful targets, and targets with placeholder mismatches; placeholder-invalid rows remain available for review instead of being incorrectly confirmed.
- Updates Review counts, active filters, pagination, row quality warnings, and an open Quality report from the already-loaded in-memory model after the bulk confirmation.
- Respects the provenance setting; when provenance is enabled, the bulk status confirmation is recorded as a status-confirmation event.
- Adds regression coverage for the bulk XLIFF transformation and the guarded editor workflow.

## 1.7.2

- Runs Quality Check automatically for all configured translation XLIFF files after the workspace/project opens (`onStartupFinished`), excluding generated `.g.xlf` files.
- Publishes startup/background QA findings directly to VS Code Problems without opening every XLIFF editor.
- Rechecks a translation XLIFF automatically after it is saved or changed on disk, including external file-system changes.
- Rechecks the affected workspace after the project glossary is saved/created/changed/deleted so terminology findings stay current.
- Rechecks after relevant Quality, maxwidth-validation, glossary, XLIFF-glob, or workspace-folder configuration changes.
- Handles XLIFF create/delete/rename through the file watcher; diagnostics for deleted files are removed.
- Reuses the already-computed Quality report when a visual XLIFF editor opens/refreshes and publishes it to Problems without a second parse.
- Adds `alXliffStudio.quality.autoRun.enabled` (default `true`) to disable all background/automatic Quality runs while keeping the explicit Quality Check command available.
- Avoids running a global full check for every keystroke; unsaved raw-editor typing is checked on save, while the visual editor continues to calculate its in-memory row quality as part of its normal refresh workflow.
- Adds automatic-QA regression coverage.

## 1.7.1

- Adds `alXliffStudio.provenance.enabled` (default `true`). When disabled, AL Xliff Studio stops recording/displaying provenance history while leaving already persisted provenance notes untouched and hidden from the normal Notes column.
- Applies the provenance setting to visual-editor commits, status confirmations, Fill Missing, AI/deterministic translation writes, and XLIFF merge output.
- Makes the per-row **✓** action available for a changed Translation draft even when the saved target is already `translated`, `signed-off`, or `final`. The button applies only that row, writes `state="translated"`, updates the companion `.lng`, and clears the draft without requiring the top-level **Apply Drafts** action.
- Keeps the normal **✓ Accept Translation** behavior for persisted review/no-state targets when no draft is present.
- Fixes fast acceptance under active filters: after Review/no-state → `translated`, the row is removed immediately from a Review-filtered page using only the already-loaded in-memory model; no full XLIFF parse or editor reload is performed.
- Updates pagination and fills an opened page slot with the next matching row without rebuilding the complete translation table.
- Adds regression coverage for disabled provenance, row-level translated-draft acceptance, and immediate Review-filter membership updates.

## 1.7.0

- Implements roadmap point 5: consistent translation provenance/history across proposals, drafts, accepted translations, bulk fill, and XLIFF merge.
- Adds structured provenance events for Developer comments, exact `.lng` matches, glossary matches, fuzzy matches (quality + matched source), AI (model id/name/vendor/family/version), manual edits, human acceptance, explicit status confirmation, and merge lineage.
- Keeps proposal/draft provenance transient until **✓ Apply Drafts**; only committed/confirmed translations write provenance into the XLIFF.
- Persists provenance as append-only `AL.XliffStudio` notes so history survives editor reloads and source control.
- Shows the current Translation/Draft origin directly in the visual editor and exposes persisted lineage in an expandable **History** section per row.
- Hides the structured provenance JSON from the ordinary Notes column while keeping it searchable through the editor's global search.
- Preserves provenance when moving a Proposal into a Translation draft; manual changes are marked Manual and retain a compact `basedOn` link to the originating proposal/translation when available.
- Records provenance in the non-visual **Fill Missing** workflow and in XLIFF-to-XLIFF merge operations as well.
- Adds a detailed AI result API so provenance records the exact VS Code language-model metadata used for a proposal/translation.
- Adds provenance roundtrip, history, merge, resolver, and visual-editor regression coverage.

## 1.6.4

- Recalculates the row-level Quality display immediately after **✓ Accept Translation** without reparsing or rerendering the complete XLIFF.
- Removes resolved state warnings such as `target-without-state` and `unknown-state` from the orange Notes/Quality hints as soon as the target becomes `translated`.
- Keeps any still-valid Quality findings (for example maxwidth, punctuation, or source=target) visible instead of clearing warnings indiscriminately.
- Updates an already-open Quality Check report and its warning/error counters in place when those state findings are resolved.
- Preserves the fast large-file acceptance path, current page, filters, and scroll position.
- Adds regression coverage for in-place Quality-note refresh after acceptance.

## 1.6.3

- Makes the per-row **✓ Accept Translation** action fast for large XLIFF files: accepting a persisted target now updates only the affected row in the webview instead of reparsing and rerendering the complete translation list.
- Applies the XLIFF document change as the smallest changed text range (normally only the target `state` attribute) instead of replacing the entire file contents.
- Keeps the current page, filters, translation scroll position, and visible row in place after acceptance.
- Updates Missing/Review counters, row status, acceptance controls, and resolved state-related QA flags in place.
- Reuses the already-known target language when updating the companion `.lng`, avoiding an extra full XLIFF parse on the acceptance path.
- Adds regression coverage that prevents `postDocument()` / full-table rerendering from returning to the row-accept workflow.

## 1.6.2

- Treats a non-empty XLIFF `<target>` without a `state` attribute as an unconfirmed **Review** translation instead of counting it as translated.
- Keeps no-state targets out of Missing/AI/Fill processing and out of confirmed `.lng` translation memory until they are explicitly accepted.
- Includes no-state targets in the XLIFF editor **Review** filter and dashboard Review metrics; Translated percentages now count only confirmed/non-review targets.
- Adds a Quality Check warning for a non-empty target without state, with normal **Go** navigation to the row.
- The existing per-row **✓** action accepts a no-state target directly, sets `state=translated`, and updates the companion `.lng`.
- Empty targets without state remain **Missing**. When Sync detects a Source change on a non-empty no-state target, it preserves the translation and promotes it to `needs-l10n`.
- Adds regression coverage for state classification, dashboard metrics, quality reporting, translation-memory exclusion, and source synchronization.

## 1.6.1

- Keep the XLIFF translation viewport at its current scroll position when creating an AI proposal for a single row.
- Row AI proposals now update the affected proposal field, origin, validation, and button state in place instead of re-rendering the entire paginated translation table.
- Added a regression test to prevent AI row actions from reintroducing scroll jumps.

## 1.6.0

- Adds context-aware AI translation for Business Central AL/XLIFF instead of sending only the English source text.
- Adds structured XLIFF Generator context (AL object type/name, element path and property), Developer notes, placeholders, maxwidth, current target/state, nearby same-object units, same-source contexts, confirmed translation-memory examples, and relevant glossary terms.
- Stops collapsing identical source texts into one AI request: each trans-unit gets a unique AI key, so the same English caption can be translated differently in different AL contexts.
- Adds a key-based AI result API while keeping the older source-keyed helper for compatibility.
- Adds configurable context limits under `alXliffStudio.ai.context.*` to keep prompts bounded for large projects.
- Uses similar confirmed `.lng` entries only as AI context examples; this does not change the explicit fuzzy-match acceptance threshold/workflow.
- Applies the same enriched context to whole-file AI fallback, Try Translation AI fallback, and the per-row AI Proposal action.
- Adds regression coverage for generator-note parsing, context assembly, context-specific duplicate-source translations, translation-memory examples, and the AI prompt contract.

## 1.5.4

- Changes the top **! Quality Check** action into a full Quality-area visibility toggle. Clicking it again now hides the complete Quality section, including the header with **↻**, **Problems**, and the accordion arrow.
- Reopening **! Quality Check** restores the existing report without rerunning it; **↻** remains the explicit refresh action.
- Keeps the internal accordion arrow independent: it still collapses only the Quality result list while leaving the Quality header visible.
- Adds regression coverage for the complete hide/show behavior.

## 1.5.3

- Makes the top **! Quality Check** action a real accordion toggle once results are available: click it again to collapse the Quality area, and again to reopen it.
- Adds a dedicated monochrome **↻** action inside the Quality header to rerun the check without overloading the accordion toggle behavior.
- Keeps the existing independent Quality/Translation scroll regions and **Go** navigation unchanged.
- Adds regression coverage for the top Quality toggle and explicit rerun action.

## 1.5.2

- Reworks the in-editor Quality Check results into a collapsible accordion area with its own independent vertical scroll region.
- Gives the Translation Units table a separate flex/scroll viewport, so a long QA result list no longer participates in the same page scroll as the translations.
- **Go** now scrolls only the Translation Units viewport to the matching row while leaving the Quality result list at its current position.
- Keeps the translation table header sticky inside its own scroll area and preserves pagination/filter navigation.
- Adds a monochrome collapse/expand control to the Quality accordion and regression coverage for the split scrolling layout.

## 1.5.1

- Fixes the Quality Check **Go** action, which previously failed because `clearQuickFilters()` recursively called itself.
- **Go** now preserves the user's active global, column, and quick-filter settings instead of clearing them.
- The selected quality issue is temporarily included as a navigation exception, the editor switches to the correct paginated page, scrolls the matching `trans-unit` into view, and highlights it.
- The navigation exception is cleared as soon as the user intentionally changes filtering, sorting, pagination, dashboard filter, or the underlying document.
- Uses render-aware retry logic so navigation still works when the target row is created asynchronously in paginated/chunked rendering.
- Adds regression coverage for Quality Go navigation and the former recursive-filter bug.

## 1.5.0

- Adds an integrated **XLIFF Quality Check** to the visual editor with a monochrome **! Quality Check** action.
- Quality Check includes staged Translation/Proposal drafts without saving them and reports errors, warnings, and informational findings in an in-editor results panel.
- Adds **Go** navigation from each unit-level QA finding to the correct filtered/paginated XLIFF row and publishes the same findings to VS Code's native **Problems** view.
- Adds checks for placeholder mismatches, `maxwidth`, source=target, leading/trailing whitespace, final punctuation, inconsistent translations for identical sources, suspicious shared targets, terminology violations, unknown/final-empty states, duplicate ids/generator contexts, and optional copied English source terms.
- Adds the OR-combined **Quality** quick filter and row-level QA indicators/messages in the XLIFF editor.
- Extends the Translation Dashboard with project-wide **Quality issues** metrics and a clickable Quality column that opens the affected XLIFF with the Quality filter active.
- Adds configurable QA switches under `alXliffStudio.quality.*`; the copied-English-term heuristic is deliberately off by default to avoid false positives for technical/product terminology.
- Adds dedicated regression tests for the quality engine, dashboard integration, and XLIFF-editor Quality workflow.

## 1.4.1

- Allows `.al-xliff-glossary.json` to live anywhere inside the XLIFF file's workspace folder instead of requiring the workspace root.
- Adds `alXliffStudio.glossary.path` for an explicit workspace-folder-relative (or local absolute) glossary location.
- When the configured glossary is missing, searches the project recursively for `.al-xliff-glossary.json` while excluding `.git`, `node_modules`, and `.alpackages`.
- Automatically uses a single discovered glossary. If multiple glossaries exist, normal translation workflows refuse to guess; **Open Terminology Glossary** asks the user to choose and stores the selected relative path in the workspace-folder settings.
- Creates missing configured glossary folders automatically when a glossary is first created.

## 1.4.0

- Adds a project-level **Terminology Glossary** stored as `.al-xliff-glossary.json` with its own visual custom editor.
- Adds **AL Xliff Studio: Open Terminology Glossary**, plus monochrome **T** access from the XLIFF editor and Translation Dashboard.
- Uses the fixed translation priority **Developer comment → exact `.lng` → exact glossary → optional fuzzy `.lng` → AI**.
- Exact glossary matches become deterministic Translation drafts/filled translations and are subsequently eligible for confirmed `.lng` memory.
- Passes glossary terms relevant to each source string into VS Code AI requests as required terminology guidance.
- Adds terminology validation in the visual XLIFF editor: rows warn when the source contains a glossary term but Translation/Proposal does not use the required target term.
- Adds an OR-combined **Terminology** quick filter and a terminology issue count to the XLIFF editor summary.
- Adds **T+** per XLIFF row to create/update a glossary term directly from the current context.
- Glossary entries support target language, `word` / `exact` / `contains` matching, optional source case sensitivity, and notes.
- Adds configuration `alXliffStudio.glossary.enabled` and regression coverage for glossary parsing, priority, validation, AI hints, manifest contributions, and glossary-editor JavaScript.

## 1.3.1

- Fixes the Translation Dashboard summary card showing `NaN` for the translated percentage.
- Adds a per-row **✓ Accept Translation** action directly below the persisted Translation field.
- The action accepts an existing non-empty, placeholder-valid target and sets its state to `translated` without creating a draft.
- Acceptance is available for review/non-final states such as `needs-l10n`, `needs-adaptation`, `needs-review-*`, `needs-translation`, `new`, and targets without a state; completed `translated`, `signed-off`, and `final` targets do not show the action.
- Accepting the current Translation also updates the companion `.lng` and clears any stale proposal for that row.

## 1.3.0

- Adds a project-wide **Translation Dashboard** with one row per translation XLIFF and aggregate workspace metrics.
- Shows target language, translated percentage, translated count, missing count, review count, placeholder errors, and structural warnings for each file.
- Makes dashboard metrics actionable: clicking Missing, Review, Translated, or Errors opens the corresponding XLIFF in the visual editor with that filter applied.
- Adds automatic dashboard refresh after saving an XLIFF plus a manual Refresh action and workspace/file/language filtering.
- Adds shared dashboard metric calculation and regression coverage for completion, review, missing, placeholder errors, and dashboard-to-editor filtering.

## 1.2.2

- Removes the relative README image that VS Code cannot reliably resolve for locally installed VSIX packages.
- Keeps the packaged extension icon configured through `package.json` (`icon: al-xliff-studio.png`).

## 1.2.1

- Fixes extension icon packaging by placing the package icon at the extension root and referencing it directly from `package.json` and the VSIX manifest.

## 1.2.0

- Renames the product and all technical identifiers consistently to **AL Xliff Studio** for a clean new installation.
- Changes the VS Code extension package id to `al-xliff-studio`, command/custom-editor prefix to `alXliffStudio`, settings section to `alXliffStudio.*`, and generated studio-note marker to `AL.XliffStudio`.
- Renames Command Palette entries, configuration titles, custom editors, notifications, documentation, CI artifact names, and package output files accordingly.
- Keeps the XLIFF/translation-memory functionality unchanged while removing obsolete BC-branded compatibility identifiers.
- Uses the bundled neutral XLIFF icon from `images/al-xliff-studio.png` for the renamed extension.

## 1.1.11

- Introduces the **AL Xliff Studio** product branding used by the later fully renamed package.
- Adds a dedicated `images/al-xliff-studio.png` extension icon and wires it into the VS Code extension manifest.
- Updates Command Palette titles, configuration title, custom-editor names, README branding, and user-facing notifications to the new product name.

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
- Adds a prominent **Fill Missing** button to the XLIFF editor. It runs the same current-file translation pipeline as `AL Xliff Studio: Fill Missing Translations in Current File` and shows the current missing-count directly in the button.
- Adds a per-row **Fill** action that processes only that trans-unit using the same priority: Developer comment → companion `.lng` → optional fuzzy match → AI only if still unresolved.
- The row Fill action asks for AI permission only when that exact row reaches the AI fallback, and uses the standard bottom-right VS Code progress notification for the single AI translation.
- Row Fill performs source synchronization against the matching `.g.xlf` for that unit before translation lookup when source-change detection is enabled.
- Fuzzy row fills are written as `needs-review-translation` with a `AL.XliffStudio` review note; confirmed comment/`.lng`/AI fills are written as `translated` and added to `.lng`.
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

- Adds a full **AL Xliff Studio — XLIFF Editor** custom editor for `.xlf` files with Source, Translation, Proposed translation, Status, Notes, and row actions.
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
- Adds **AL Xliff Studio: Open Visual XLIFF Editor** and Explorer/editor-title context-menu integration.
- Adds regression tests for the XLIFF webview, editor contribution, unit editing/status changes, and `translate="no"` protection.

## 1.0.11

- Fixes fuzzy-match handling: `needs-review-translation` is now a review state and is no longer counted as missing or sent to AI.
- Preserves `needs-adaptation`, `needs-l10n`, and `needs-review-*` targets for human review instead of automatically retranslating them.
- Excludes review-state targets from `.lng` translation memory so unconfirmed fuzzy/merge/source-change candidates cannot become trusted lookup entries.
- Moves source-change synchronization before translation lookup and copies the current `<source>` content from the matching `.g.xlf` into the translation XLIFF.
- Matches generator files by basename first (`MyApp.de-DE.xlf` → `MyApp.g.xlf`) and refuses to guess when multiple fallback `.g.xlf` files exist.
- Source-change handling is no longer blocked by unrelated `AL.XliffStudio` fuzzy/merge notes; only the specific source-change note is idempotent.
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
- Adds the `AL Xliff Studio: Merge Translations Between Files` command with three modes (Untranslated/Overwrite/Add) to copy translations between two already-translated XLIFF files.
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
