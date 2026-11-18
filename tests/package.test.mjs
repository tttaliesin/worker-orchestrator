import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPackage } from '../builders/codex/build.mjs';
import { checkPackage } from '../scripts/check-package.mjs';
import { createInstallation } from './installed/fixture.mjs';

// A single build snapshot is copied per adversarial case; default dist/ is untouched.
const installation = createInstallation('package-test');

async function replaceResource(root, relative, transform) {
  const filename = path.join(root, relative);
  const data = Buffer.from(transform(await readFile(filename, 'utf8')));
  await writeFile(filename, data);
  const manifestPath = path.join(root, 'package-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[relative] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  await writeFile(manifestPath, JSON.stringify(manifest));
}

test('relocated package validates itself and runs capabilities with only installed resources', async () => {
  const fixture = await installation;
  await assert.rejects(access(path.join(fixture.root, 'src')));
  const checked = await checkPackage({ root: fixture.root, stateDir: fixture.stateDir });
  assert.equal(checked.version, '0.1.0');
  assert.deepEqual(checked.skills, ['worker-controller', 'worker-executor']);
  const selfCheck = fixture.run('scripts/check-package.mjs', ['--state-dir', fixture.stateDir]);
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  assert.equal(JSON.parse(selfCheck.stdout).root, fixture.root);
  assert.equal((await fixture.cli('capabilities')).execution, 'controller-mediated');
  const catalog = await checkPackage({ root: fixture.built.packageRoot, marketplaceRoot: fixture.catalogRoot, smoke: false });
  assert.equal(catalog.marketplaceChecked, true);
});

test('checker detects changed bytes even when a filename and byte count are unchanged', async () => {
  const root = await (await installation).clone('tampered');
  const filename = path.join(root, 'dist/cli.mjs');
  const source = await readFile(filename, 'utf8');
  await writeFile(filename, source.replace('main();', 'maim();'));
  await assert.rejects(checkPackage({ root, smoke: false }), /Hash mismatch/);
});

test('checker rejects a missing internal Markdown target even with a matching hash', async () => {
  const root = await (await installation).clone('missing-link');
  await replaceResource(root, 'README.md', source => `${source}\n[missing](docs/absent.md)\n`);
  await assert.rejects(checkPackage({ root, smoke: false }), /Missing resource/);
});

test('checker accepts simple quoted YAML discovery values', async () => {
  const root = await (await installation).clone('quoted-discovery');
  await replaceResource(root, 'skills/worker-controller/SKILL.md', source => source
    .replace('name: worker-controller', 'name: "worker-controller"')
    .replace(/^description: .+$/m, "description: 'Manage a controller''s authorized worker chats.'"));
  assert.equal((await checkPackage({ root, smoke: false })).ok, true);
});

test('checker follows Markdown reference destinations', async () => {
  const root = await (await installation).clone('missing-reference');
  await replaceResource(root, 'README.md', source => `${source}\n[Guide][guide]\n\n[guide]: docs/absent.md\n`);
  await assert.rejects(checkPackage({ root, smoke: false }), /Missing resource/);
});

test('manifest entries cannot traverse outside the installed root', async () => {
  const root = await (await installation).clone('path-traversal');
  const filename = path.join(root, 'package-manifest.json');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  manifest.files['../outside'] = { sha256: '0'.repeat(64), bytes: 0 };
  await writeFile(filename, JSON.stringify(manifest));
  await assert.rejects(checkPackage({ root, smoke: false }), /Non-normalized manifest path/);
});

test('runtime imports cannot depend on an npm module or leave the package', async () => {
  const fixture = await installation;
  for (const [name, specifier] of [['bare-import', 'missing-npm-module'], ['escaped-import', '../../outside.mjs']]) {
    const root = await fixture.clone(name);
    await replaceResource(root, 'dist/cli.mjs', source => `${source}\nimport '${specifier}';\n`);
    await assert.rejects(checkPackage({ root, smoke: false }), /External runtime dependency|Resource escapes package/);
  }
});

test('build preserves foreign output files and checker reports the stale inventory', async () => {
  const fixture = await installation;
  const foreign = path.join(fixture.built.packageRoot, 'foreign.txt');
  await writeFile(foreign, 'preserve this file');
  await buildPackage({ outputRoot: fixture.catalogRoot });
  assert.equal(await readFile(foreign, 'utf8'), 'preserve this file');
  await assert.rejects(checkPackage({ root: fixture.built.packageRoot, smoke: false }), /File inventory differs/);
});
