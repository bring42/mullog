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

## Open files from your phone

mullog can be installed as an app and receive files from the system share sheet or "Open with" menu. Files still never leave your device: shared files are caught by the service worker and handed to the page through local storage, and iPhone links carry the file in the URL fragment (`#…`), which browsers never send to a server.

### Android (Chrome)

1. Open https://log.n527.eu in Chrome and choose **⋮ → Install app** (or accept the install prompt). The installed app opens in its own window, without the Chrome address bar.
2. In any app (Files, Gmail, Termux, …) share a `.log`, `.txt`, `.csv` or `.tsv` file and pick **mullog**. It opens straight away.

mullog only appears in the share sheet after a real install. A shortcut-style **Add to home screen** (an icon that opens a Chrome tab) is not enough. If you made one of those before mullog was installable, remove it from the home screen, reload the site once, then use **Install app**. If Chrome only offers "Add to home screen", reload the page and wait a few seconds so the service worker can register, then open the menu again.

Sharing plain text (not a file) to mullog also works; it is opened as `shared.log`.

### Desktop (Chrome / Edge)

1. Install mullog from the address-bar install icon.
2. Right-click a log or CSV file → **Open with → mullog**. (You can also still drag files onto the page.)

### iPhone / iPad (Shortcuts)

You can add mullog to the Home Screen (Safari → Share → **Add to Home Screen**) and it runs full screen and works offline. Inside that app you can open files with the file picker (Files, iCloud Drive, …) or tap **Paste log text**. iOS doesn't let home-screen web apps appear in the share sheet, though, and links opened by a Shortcut always open in Safari, not in the home-screen app. So the Shortcut below hands the file to mullog in Safari.


Safari does not support web share targets yet, so use a Shortcut that packs the file into a link:

1. Open **Shortcuts** → **+** → name it e.g. "Open in mullog".
2. Tap the **ⓘ** (details) → enable **Show in Share Sheet** and set accepted types to **Files** (and Text, optionally).
3. Add these actions in order:
   1. **Receive** *Files* **from** *Share Sheet* (if there's no input: *Stop and Respond*).
   2. **Make Archive** → format **gzip** (tap "Format"), input *Shortcut Input*.
   3. **Base64 Encode** *Archive* → tap the arrow and set **Line Breaks: None**.
   4. **URL** → `https://log.n527.eu/#gz=[Base64 Encoded]&name=[Shortcut Input → Name]` (insert the two magic variables).
   5. **Open URLs** *URL*.
4. In Files/Mail/etc., share a log file → **Open in mullog**. Safari opens mullog with the file loaded and immediately removes the data from the address bar and history.

The link route is limited by how long a URL Shortcuts and Safari will pass along; logs compress well (often 5–10×), but keep the compressed file to roughly 1–2 MB. For larger files, or as a quick alternative, copy the text instead (a Shortcut with **Get Text from Input → Copy to Clipboard → Open URLs `https://log.n527.eu`**, or just copy it yourself) and tap **Paste log text** on mullog's start screen. `#b64=<base64>&name=…` without gzip is accepted too.

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
