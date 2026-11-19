import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../builders/codex/build.mjs';
import { checkPackage } from '../scripts/check-package.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const localRoot = path.join(repositoryRoot, '.local');
const sources = ['package.json', 'builders', 'docs', 'scripts', 'src', 'workflows'];
const readJSON = async filename => JSON.parse(await readFile(filename, 'utf8'));
const run = (cwd, executable, ...args) =>
  execFileSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const git = (root, ...args) => run(root, 'git', ...args);
const gitIdentity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
const commit = (root, message) => git(root, ...gitIdentity,
  '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', message);
const tagHead = (root, tag) => git(root, '-c', 'tag.gpgSign=false', 'tag', tag, 'HEAD');

async function copySources(root) {
  await Promise.all(sources.map(relative =>
    cp(path.join(repositoryRoot, relative), path.join(root, relative), { recursive: true })));
}

async function gitFixture(t) {
  await mkdir(localRoot, { recursive: true });
  const root = await mkdtemp(path.join(localRoot, 'tagged-version-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await copySources(root);
  git(root, 'init', '-q');
  git(root, '-c', 'core.autocrlf=false', 'add', '--', ...sources);
  commit(root, 'Fixture base commit');
  return root;
}

async function assertPackagedVersion(built, version, releaseTag = null) {
  const { packageRoot, marketplaceRoot } = built;
  const [portable, compatibility, manifest] = await Promise.all(
    ['plugin.json', '.codex-plugin/plugin.json', 'package-manifest.json'].map(relative =>
      readJSON(path.join(packageRoot, relative))));
  assert.equal(built.version, version);
  assert.equal(portable.version, version);
  assert.equal(compatibility.version, version);
  assert.equal(manifest.version, version);
  assert.equal(manifest.releaseTag ?? null, releaseTag);
  const installed = JSON.parse(run(packageRoot, process.execPath, 'dist/cli.mjs', '--version'));
  assert.equal(installed.version, version);
  const checked = await checkPackage({ root: packageRoot, marketplaceRoot, smoke: false });
  assert.equal(checked.version, version);
  assert.equal(checked.marketplaceChecked, true);
}

test('the single release tag at HEAD supplies the packaged and catalog-checked version', async t => {
  const repoRoot = await gitFixture(t);
  tagHead(repoRoot, 'v8.0.0');
  commit(repoRoot, 'Current release commit');
  git(repoRoot, ...gitIdentity, '-c', 'tag.gpgSign=false', 'tag', '-a', '-m', 'Fixture release', 'v8.2.3-rc.1+build.4', 'HEAD');
  const built = await buildPackage({ repoRoot });
  assert.equal(built.revision, git(repoRoot, 'rev-parse', 'HEAD'));
  await assertPackagedVersion(built, '8.2.3-rc.1+build.4', 'v8.2.3-rc.1+build.4');
});

test('an explicit build CLI tag selects one of multiple releases at HEAD', async t => {
  const repoRoot = await gitFixture(t);
  tagHead(repoRoot, 'v8.2.3');
  tagHead(repoRoot, 'v8.3.0');
  await assert.rejects(buildPackage({ repoRoot }), /Multiple release tags/);
  const built = JSON.parse(run(repoRoot, process.execPath, 'builders/codex/build.mjs', '--tag', 'v8.2.3'));
  await assertPackagedVersion(built, '8.2.3', 'v8.2.3');
});

test('a build without a release tag at HEAD uses the development version', async t => {
  const repoRoot = await gitFixture(t);
  tagHead(repoRoot, 'v8.2.3');
  const filename = path.join(repoRoot, 'package.json');
  const metadata = await readJSON(filename);
  metadata.version = '8.4.5';
  await writeFile(filename, JSON.stringify(metadata));
  git(repoRoot, '-c', 'core.autocrlf=false', 'add', '--', 'package.json');
  commit(repoRoot, 'Untagged development commit');
  await assertPackagedVersion(await buildPackage({ repoRoot }), metadata.version);
});

test('an exported source directory does not inherit a tag from its parent checkout', async t => {
  const parent = await gitFixture(t);
  tagHead(parent, 'v8.2.3');
  const repoRoot = path.join(parent, 'exported source');
  await mkdir(repoRoot);
  await copySources(repoRoot);
  const built = await buildPackage({ repoRoot });
  assert.equal(built.revision, null);
  const metadata = await readJSON(path.join(repoRoot, 'package.json'));
  await assertPackagedVersion(built, metadata.version);
});

test('explicit release tags must exist, be valid versions, and point to HEAD', async t => {
  const repoRoot = await gitFixture(t);
  tagHead(repoRoot, 'v8.2.3');
  commit(repoRoot, 'Current development commit');
  tagHead(repoRoot, 'v08.2.4');
  for (const [tag, reason] of [['v9.0.0', /does not exist/], ['v08.2.4', /valid SemVer/], ['v8.2.3', /must point to the build HEAD/]]) {
    await assert.rejects(buildPackage({ repoRoot, tag }), reason);
  }
});

test('the catalog checker rejects a manifest release tag that disagrees with the version', async t => {
  const repoRoot = await gitFixture(t);
  const { packageRoot, marketplaceRoot } = await buildPackage({ repoRoot });
  const check = () => checkPackage({ root: packageRoot, marketplaceRoot, smoke: false });
  assert.equal((await check()).marketplaceChecked, true);
  const filename = path.join(packageRoot, 'package-manifest.json');
  const manifest = await readJSON(filename);
  manifest.releaseTag = manifest.version === '8.2.3' ? 'v8.2.4' : 'v8.2.3';
  await writeFile(filename, JSON.stringify(manifest));
  await assert.rejects(check, /Manifest release tag must match the version/);
});

test('the checker smoke test rejects a CLI version that disagrees with the manifests', async t => {
  const repoRoot = await gitFixture(t);
  tagHead(repoRoot, 'v8.2.3');
  const { packageRoot } = await buildPackage({ repoRoot });
  const relative = 'dist/cli.mjs';
  const entry = path.join(packageRoot, relative);
  const source = await readFile(entry, 'utf8');
  const modified = source.replace('"8.2.3"', '"8.2.4"');
  assert.notEqual(modified, source);
  await writeFile(entry, modified);
  const manifestPath = path.join(packageRoot, 'package-manifest.json');
  const manifest = await readJSON(manifestPath);
  manifest.files[relative] = { bytes: Buffer.byteLength(modified), sha256: createHash('sha256').update(modified).digest('hex') };
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await checkPackage({ root: packageRoot, smoke: false })).ok, true);
  await assert.rejects(checkPackage({ root: packageRoot, stateDir: path.join(repoRoot, '.local', 'state') }),
    /Installed CLI version must match the manifest/);
});
