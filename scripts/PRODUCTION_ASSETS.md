# Production assets and automatic style fallback

React and ReactDOM use the official 17.0.2 production UMD builds. Their development counterparts remain available for rollback. JSX still compiles in the browser; no frontend build command is required to edit this application.

Tailwind 3.4.17 CSS is generated from the current HTML and frontend source. PHP checks a content fingerprint and the stylesheet hash on each page load. Matching files use the generated stylesheet; an edit, missing stylesheet, or integrity mismatch automatically selects the original runtime Tailwind engine. The default Tailwind theme/configuration is unchanged. Styles are loaded after the other head styles, matching the previous runtime insertion location.

This fallback preserves save-and-refresh, but generated-CSS performance benefits pause after source edits until the generated stylesheet is refreshed. This is a deliberate tradeoff, not an automatic background CSS build. React production mode, compression, and versioned caching remain active in either mode.

The optional maintainer script `scripts/generate-styles.cjs` refreshes CSS and its manifest using Tailwind 3.4.17 plus PostCSS installed outside the web directory under `%LOCALAPPDATA%/CodexTools/tailwind-3.4.17/node_modules`. `TAILWIND_TOOLS_DIR` can point to equivalent dependencies elsewhere. The hosting server does not need Node.js; upload the generated stylesheet, manifest and PHP helpers with the app. Keep the original runtime Tailwind file for the fallback.

Verified: production React version/APIs; gzip transfer sizes; all three entry URLs selecting generated CSS; content-version caching; fallback on source edits and CSS damage; return to generated CSS after undoing edits. A connected browser was unavailable, so logged-in visual layout and interactions still need testing.

Before-change backups:
`C:\Users\Administrator\AppData\Local\CodexBackups\3D1.3xxsc-production-assets-20260908-210044`
