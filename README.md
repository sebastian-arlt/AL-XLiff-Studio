# AL Xliff Studio

**Translate Business Central AL apps — clearly, directly in VS Code.**

See what is missing, reuse existing translations and review every proposal before applying it. English is the default interface language; German is selected automatically when VS Code uses German. The interface language is independent of your XLIFF languages.

[Deutsche Beschreibung](https://github.com/sebastian-arlt/AL-XLiff-Studio/blob/main/docs/readme.de.md)

## All languages at a glance

The **Translation Dashboard** shows progress, missing translations, review entries and quality issues for each language. Open the wizard or XLIFF Editor beside a file. Synchronize an individual language when its source is out of date.

![Translation Dashboard with language progress and direct actions](https://raw.githubusercontent.com/sebastian-arlt/AL-XLiff-Studio/main/resources/overview/dashboard.png)

## Translate one step at a time

**Guided Translation** takes you through missing translations, reviews and quality fixes. Source text, current translation, proposals and developer notes appear together.

- **← / →** move between entries and preserve your input as a draft.
- **Use proposal** fills the editing field. **Apply** confirms the translation.
- **AI proposal** requests another suggestion when you need one.
- **¶** reveals invisible characters without changing the text.

A matching developer note can become a proposal when the translation differs from it. The final summary shows remaining work and lets you continue with missing entries, skipped entries, reviews or quality fixes.

![Guided Translation with a source, current translation and developer proposal](https://raw.githubusercontent.com/sebastian-arlt/AL-XLiff-Studio/main/resources/overview/guided.png)

## Work with several entries

The **XLIFF Editor** shows translations side by side. Filter missing entries, drafts, proposals and quality issues. Search and pagination keep large files manageable.

The **magnifying glass** opens the matching AL definition, such as a Label, Caption or ToolTip. Developer notes and translation origins provide context.

![XLIFF Editor with sources, translations, states and developer notes](https://raw.githubusercontent.com/sebastian-arlt/AL-XLiff-Studio/main/resources/overview/editor.png)

## Reuse your work

| Feature | What it does |
| --- | --- |
| **Sync** | Updates a translation file from the current generated texts. |
| **Local translations** | Uses developer comments, language maps and glossary matches. |
| **Glossary** | Helps you use consistent terminology. |
| **Quality Check** | Finds placeholder errors, developer-comment differences and terminology issues. |
| **AL hover** | Shows existing translations while you work in AL code. |
| **AI Usage** | Shows recorded AI translation usage. |

**You decide what to apply.** A proposal is not a confirmed translation. Apply changes the open file; Save writes it to disk. AI features use an available VS Code language model.

## Get started

1. Open your AL project in VS Code.
2. Open **AL Xliff Studio** in the sidebar. Expand a language in **Project Overview** or open the dashboard.
3. Choose **Guided Translation** for a guided workflow or **XLIFF Editor** for the full table view.

For a new language, first check sync and prepare local translations. If a language listed in app.json has no XLIFF, the dashboard offers to create one when a matching generated file is available.

The images show real views with example data, including German UI examples. VS Code 1.97 or later is required. Install a local VSIX through **Extensions: Install from VSIX…**. To switch the interface language, use **Configure Display Language** in VS Code and restart when prompted.

[Technical reference](https://github.com/sebastian-arlt/AL-XLiff-Studio/blob/main/docs/technical-reference.md)
