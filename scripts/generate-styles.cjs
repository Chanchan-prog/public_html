// Optional maintainer tool. The application automatically falls back to runtime
// Tailwind after source edits, so users do not need to run this to see changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const tools = process.env.TAILWIND_TOOLS_DIR || path.join(process.env.LOCALAPPDATA || '', 'CodexTools', 'tailwind-3.4.17', 'node_modules');
const tailwind = require(path.join(tools, 'tailwindcss'));
const postcss = require(path.join(tools, 'postcss'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const paths = ['public/index.html'];
function walk(directory) {
  for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) walk(file);
    else if (/\.(js|jsx|css)$/.test(item.name)) paths.push(path.relative(root, file).replace(/\\/g, '/'));
  }
}
walk(path.join(root, 'src'));
paths.sort();
const fingerprint = sha(paths.map(p => p + '\0' + sha(fs.readFileSync(path.join(root, p))) + '\n').join(''));
(async () => {
  const content = paths.filter(p => !p.endsWith('.css')).map(p => ({raw:fs.readFileSync(path.join(root, p), 'utf8'), extension:path.extname(p).slice(1)}));
  const result = await postcss([tailwind({content, theme:{extend:{}}, plugins:[]})]).process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', {from:undefined});
  const directory = path.join(root, 'public', 'vendor', 'tailwind');
  fs.writeFileSync(path.join(directory, 'generated.min.css'), result.css);
  fs.writeFileSync(path.join(directory, 'generated-manifest.json'), JSON.stringify({tailwind_version:'3.4.17', source_hash:fingerprint, css_hash:sha(result.css)}, null, 2));
  console.log('Generated styles refreshed. Save-and-refresh remains available through the automatic fallback.');
})().catch(error => {console.error(error); process.exitCode=1;});
