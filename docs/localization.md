# Interface localization

AL Xliff Studio 1.11.86 ships one VSIX with English and German. VS Code's display language selects the interface language; a restart after changing that language is expected. XLIFF source and target languages are independent of the interface language.

## Translation files

- `package.nls.json`: English command titles, editor/view names and setting descriptions. Manifest references use `%key%`.
- `package.nls.de.json`: German equivalents with the same keys.
- `l10n/bundle.l10n.json`: English runtime messages.
- `l10n/bundle.l10n.de.json`: German runtime messages keyed by their English source text.
- `src/localization.js`: native `vscode.l10n.t` integration, English/German fallback for host adapters, HTML/JavaScript escaping and localization of English worker findings.

Use `t('English text', ...args)` in the extension host. Number dynamic values as `{0}`, `{1}`, etc.; translate the complete message where possible. For static webview HTML use `htmlText`, and for a string literal in a generated webview script use `scriptString`. These helpers escape translated text for the appropriate context. No document-wide replacement or DOM translation observer is used.

Only extension-owned messages are localized. Source/target text, filenames, developer-note contents, locale identifiers, command/message IDs, XML states, quality codes and provenance origin codes remain data. Worker computation retains its original finding structure; only display messages are localized when a worker result reaches the German host.

## Adding another language

Add matching `package.nls.<locale>.json` and `l10n/bundle.l10n.<locale>.json` files. Extend the supported-language selection/fallback in `src/localization.js` so the webview `lang` attribute and host test adapters also recognize that locale. Preserve numbered placeholders and keep all command IDs and defaults unchanged. Add the locale to `test/localization.test.js` and visually check long labels. One common webview and host implementation serves all languages.

## Verification

`npm test` checks all six generated views in English, German, de-DE and an unsupported-language English fallback, their script syntax, workflow availability, catalog keys, numbered placeholders, native API delegation and safe escaping. It also verifies that localized quality findings preserve source/target text, severity and ordinal references. `npm run check` checks JavaScript syntax. Native VS Code display-language switching remains a separate manual acceptance step.
