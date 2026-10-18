// Builds demo/dist/tag-weekly-report-r12-demo.html — a single self-contained page.
// Usage: node demo/build.mjs <path-to-esbuild> <path-to-sql-wasm.wasm>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [esbuild, wasmPath] = process.argv.slice(2);
if (!esbuild || !wasmPath) { console.error('usage: node demo/build.mjs <esbuild> <sql-wasm.wasm>'); process.exit(1); }

const js = execFileSync(esbuild, [join(HERE, 'entry.js'), '--bundle', '--format=esm', '--target=es2022', '--minify', '--legal-comments=none'], { maxBuffer: 64 * 1024 * 1024 }).toString();
const css = readFileSync(join(HERE, '..', 'web', 'styles.css'), 'utf8');
const wasm = readFileSync(wasmPath).toString('base64');
const extraCss = `
.boot { min-height: 100%; display: grid; place-items: center; padding-block: 40px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); color: var(--on-brand); background: var(--brand); text-align: center; }
html, body { height: 100%; }
.record-overlay { position: fixed; inset: 0; z-index: 50; background: var(--bg); overflow-y: auto; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
.record-bar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; justify-content: space-between; background: var(--surface); border-bottom: 1px solid var(--line); padding-block: 10px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.record-bar p { margin: 0; color: var(--ink-2); font-size: .88rem; }
.record-paper { max-width: 760px; margin: 0 auto; padding-block: 16px 40px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.record-paper table { width: 100%; border-collapse: collapse; } .record-paper td { border-bottom: 1px solid var(--line); padding: 8px 4px; vertical-align: top; }
.record-paper .demo { background: var(--note-bg); color: var(--note-ink); border: 1px solid var(--note-line); padding: 8px 12px; border-radius: 6px; }
.record-paper .sig { font-size: 12px; color: var(--ink-2); } .record-paper code, .record-paper pre { word-break: break-all; white-space: pre-wrap; font-size: 11px; }
.demo-ribbon { background: var(--note-bg); color: var(--note-ink); font-size: .8rem; text-align: center; padding-block: 6px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
`;
const html = `<title>TAG Weekly Report</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="theme-color" content="#14213d">
<style>${css}${extraCss}</style>
<div class="demo-ribbon">R1.2 click-through demo with invented people. The same rules engine as the server build runs inside this page; nothing is saved or sent, and text alerts are simulated.</div>
<div id="app"><div class="boot" id="boot">Loading the demo…</div></div>
<div id="live" class="sr" aria-live="polite" role="status"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js"></script>
<script>window.__SQL_WASM_B64 = "${wasm}";</script>
<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>
`;
mkdirSync(join(HERE, 'dist'), { recursive: true });
const out = join(HERE, 'dist', 'tag-weekly-report-r12-demo.html');
writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB');
