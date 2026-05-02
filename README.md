# Log Inspection Workbench

Try it out: https://log.n527.eu

A static-deployable SvelteKit + TypeScript app for inspecting, parsing, filtering, and exporting local `.txt`, `.log`, and `.csv` files. All processing happens in the browser. There is no backend and no file upload to a server.

## Features

- Local drag/drop or file picker input for `.txt`, `.log`, and `.csv` files
- Browser-side decoding via `TextDecoder`
- Encoding detection and manual override for:
  - UTF-8
  - UTF-8 with BOM
  - Windows-1252
  - ISO-8859-1
- Auto detection for CSV vs plain text logs
- CSV delimiter detection for comma, semicolon, tab, and pipe
- Header detection, robust quoted CSV parsing, malformed-row warnings
- TXT parsing for line number, raw line, timestamp, severity, category/source, and message
- Timestamp pattern detection, severity detection, bracketed tag/category inference, prefix inference, repeated-token inference
- Visible parser assumptions and confidence values
- Live filters for search, severity, category/source, time range, and inferred categorical CSV columns
- Active filter tokens
- Raw, structured, and hybrid table views
- Row inspector with raw line, parsed fields, line number, and detection notes
- CSV export of the currently filtered rows
- Keyboard shortcuts:
  - `/` focuses search
  - `Esc` closes the selected row inspector and mobile filter drawer
  - `E` exports the current filtered result
- Warm technical drafting-paper UI with utilitarian/neo-brutalist styling

## Run locally

```bash
npm install
npm run dev
```

## Static build

```bash
npm run build
npm run preview
```

The static output is written to `build/` by `@sveltejs/adapter-static`.

## Project structure

```text
src/lib/components/FileDropzone.svelte
src/lib/components/DetectionPanel.svelte
src/lib/components/FilterRail.svelte
src/lib/components/LogTable.svelte
src/lib/components/RowInspector.svelte
src/lib/components/ExportButton.svelte
src/lib/parser.ts
src/lib/encoding.ts
src/lib/filters.ts
src/lib/demo.ts
src/routes/+page.svelte
src/app.css
```

## Notes

- No heavy runtime dependencies are used.
- CSV parsing is implemented locally instead of pulling in PapaParse.
- The app uses SvelteKit's static adapter and disables SSR for the route so browser-only file APIs stay client-side.
