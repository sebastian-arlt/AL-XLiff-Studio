# Large-XLIFF stress verification

Run `npm test`, `npm run check`, then `npm run test:stress` from the source directory.
The stress runner also works without package installation: `node tools/large-xlf-stress.cjs`.
No translation service or external project is required.

The deterministic generator creates exactly 30,000 translation units with approximately
15 MB of UTF-8 XML (15,491,657 bytes), mixed translated/missing/no-state targets,
placeholder errors, punctuation warnings, and unique generator notes. The report
includes its SHA-256 hash, Node version, CPU, OS and memory information.

Output lives under `artifacts/large-xlf/`:

- `Translations/Stress.de-DE.xlf`: generated document, subsequently edited by the scenario.
- `Translations/Stress.g.xlf`: generated companion with a changed source.
- `.alxliffstudio/lng/Stress.de-DE.lng`: translation memory created by Apply/Sync.
- `.alxliffstudio/debug/performance.log`: existing opt-in performance trace infrastructure,
  extended with worker lifecycle and event-loop maximum/p99 measurements.
- `stress-report.json`: phase measurements, assertions, worker events, transferred bytes,
  and performance-budget violations. On failure, `stress-failure.json` captures partial results.

The generator resets the fixture at the start of each run. It only writes in the output
directory; use `--output=artifacts/my-run` for another independent run. Reusing a directory
retains earlier translation memory/logs, so use a fresh output directory for comparable cold runs.

The runner exercises the real editor provider and message handlers with real files,
parsers, Quality analyzer, document sessions and worker threads. Its adapter represents
VS Code document edits, events, diagnostics and the webview transport. Each phase records
elapsed time, RSS/heap snapshots and sampled peaks, a 10 ms event-loop histogram, a 5 ms
heartbeat, worker starts/cancellations and bytes transferred. Process RSS includes workers;
brief peaks between samples can be missed. The heartbeat reports stall above its nominal
5 ms interval; histogram delays include their 10 ms sampling floor.

Assertions cover opening and first page, filtering/sorting, translation paging, deferred
Quality Check, capped Problems diagnostics, Quality filtering/sorting and cached pages,
Problems navigation mapping, QC-Go with active filters, volatile drafts, draft-aware QA,
Apply, Save, rapid Quality refresh, source Sync and companion memory, changes during parsing,
close during Quality work, no concurrent superseded worker and no blocking popup.
Quality metadata contains no full findings arrays; each page is bounded at 200 items.

Default regression ceilings are 5,000 ms for heartbeat stall and 2,048 MiB for RSS,
including the adapter. They are deliberately broad regression alarms, not a claim that
every UI action meets 100 ms. Phases with stalls above 100 ms are reported separately.
Set stricter machine-specific ceilings with:

```
node tools/large-xlf-stress.cjs --output=artifacts/budget-run --max-stall-ms=100 --max-rss-mb=1024
```

## Rendered VS Code acceptance check

The automated runner does not measure Chromium painting, actual VS Code input latency
or the Problems widget. The generated webview script has separate runtime regression
tests for page requests, stale replies, severity changes and finding references.
Complete this checklist in an Extension Development Host or installed VSIX for UI acceptance:

1. Open the generated AL project folder and translation XLIFF with the visual editor.
2. Enable `alXliffStudio.debug.performance.enabled` and open the performance log.
3. Type in Source/Translation filters, toggle quick filters, sort columns and visit first,
   middle and last translation pages. Check scroll position and responsiveness.
4. Run Quality Check, change severity filters/page sizes, visit first/last pages, switch
   Ignored/Problems, and exercise local/project Ignore and Restore.
5. Use a Problems Quick Fix and QC-Go while filters are active. Confirm the correct row,
   preserved filters and severity highlight.
6. Edit a draft, run Quality Check with drafts, Apply and Save. Check that editing remains
   usable during background QA and that hidden/collapsed Quality views retain their state.
7. Sync against the generated companion; inspect changed source/state and translation memory.
8. Refresh repeatedly, change XML in another editor, and close while parsing/QA is running.
   Check worker `started`/`terminated` events, cancelled outcomes and absence of stale results.

Retain performance.log and a VS Code profile for any UI stall. Large existing Sync/Apply
paths still include synchronous XML/translation-memory work; the runner makes those
limitations visible instead of treating the entire scenario as an off-thread operation.

## Roadmap section-one budgets (1.11.59)

The adapter test fails if Sync stalls the host for more than 500 ms (`--max-sync-stall-ms` overrides this) or Quality filtering/paging stalls for more than 100 ms. General stall/RSS limits remain in effect. Remaining >100-ms phases are reported separately and belong to the next roadmap section. Large Sync must show a completed `sync` worker. Budget assessment is shared with the regression test in `test/stress-budgets.test.js`.
