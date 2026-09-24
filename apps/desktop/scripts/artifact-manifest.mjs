import { createHash } from 'node:crypto';
import { appendFile, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const files = process.platform === 'darwin'
  ? ['SideTask-macos.zip']
  : (await readdir('src-tauri/target/release/bundle/nsis')).filter(name => name.endsWith('.exe')).map(name => `src-tauri/target/release/bundle/nsis/${name}`);
if (!files.length) throw new Error('No installer found after the build.');
const lines = ['## Built trial packages', '', 'Package creation is separate from artifact upload. A failed upload means these files are not available for download.', '', '| File | Bytes | SHA-256 |', '| --- | ---: | --- |'];
for (const path of files.sort()) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  lines.push(`| ${path} | ${(await stat(path)).size} | ${hash.digest('hex')} |`);
}
const report = `${lines.join('\n')}\n`;
process.stdout.write(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
