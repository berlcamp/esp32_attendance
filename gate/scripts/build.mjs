// Bundles the service into ONE file for the mini PC: no node_modules, no
// native modules, nothing to compile on the target. Copies deploy/ beside it.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', '--short', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.') !== '';
const version = dirty ? `${sha}-dirty` : sha;

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/gate.mjs',
  external: ['node:sqlite'],
  define: { GATE_VERSION: JSON.stringify(version) },
  banner: { js: `// gate ${version}` },
});
cpSync('deploy', 'dist/deploy', { recursive: true });
writeFileSync('dist/VERSION', `${version}\n`);
console.log(`built dist/gate.mjs (${version})`);
