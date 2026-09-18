# CSP and upload protections

Implemented September 8, 2026. Existing business records and uploaded assets were not migrated or removed.

## File handling

- File-manager uploads require an allowed extension and matching detected content, up to 10 MB. Raster images are checked for valid dimensions. Office ZIP directories are checked without extracting their contents; PHP ZipArchive is not required.
- Uploaded documents are downloaded through `index.php/api/file-upload?action=download&file_id=...`. The existing file-manager owner/admin permission rule also applies to downloads. Responses are attachments with no-store and nosniff headers.
- Direct HTTP access to `api/uploads` is denied. Keep both the server and upload-folder `.htaccess` files when deploying. For non-Apache servers, configure an equivalent deny rule before publishing.
- Existing metadata and stored filenames remain compatible with the download handler. Paths are resolved and confined to the upload directory before download or deletion.
- Public building GLB files remain public and retain their existing content/header validation. Their upload folder denies executable extensions. Profile image uploads must decode successfully; existing profile images are unchanged.
- Validation is not antivirus scanning. Downloaded documents and ZIP archives can still contain harmful content; archives are never extracted or executed by this handler.

## Content Security Policy

- PHP entry points and static HTML receive one enforced compatibility policy. Object embeds are blocked; base URLs, forms and framing are restricted to the same origin. Resource directives allow the application's local resources, blob modules, and known CDN fallbacks.
- Inline scripts/styles and eval remain permitted for compatibility with the current runtime JSX/Tailwind loader. This is not a strict XSS-prevention CSP.
- A stricter script policy runs report-only. Violations appear in the browser console; there is no remote report collector. Removing those exceptions requires frontend changes and browser verification.

## Verification completed

- Changed PHP files linted; all 61 frontend JS/JSX modules compiled with the application's Babel version.
- Text, PNG, JSON, DOCX, XLSX and ZIP fixtures accepted; executable/HTML/SVG extensions and mismatched images rejected.
- Owner/admin download handler tests passed; unrelated users denied. Fixtures used temporary test rows, and the empty persistent table initialized by the handler during testing was removed to restore the original schema.
- HTTP checks: homepage, direct public HTML and a building model return 200; anonymous download returns 401; direct private storage returns 403. CSP header duplication was checked and corrected.
- A browser was unavailable, so logged-in visual workflows, report exports, notification behavior and email delivery were not verified interactively. Recheck those before public deployment, as well as the host's enforcement of `.htaccess`.

Pre-change copies of modified existing files are stored outside the web directory at:
`C:\Users\Administrator\AppData\Local\CodexBackups\3D1.3xxsc-security-20260908-145650`
