// @flow
const assert = require('assert');
const {readFileSync, createWriteStream} = require('fs');
const {install} = require('../commands/install.js');
const {add} = require('../commands/add.js');
const {upgrade} = require('../commands/upgrade.js');
const {remove} = require('../commands/remove.js');
const {ci} = require('../commands/ci.js');
const {dedupe} = require('../commands/dedupe.js');
const {purge} = require('../commands/purge.js');
const {yarn: yarnCmd} = require('../commands/yarn.js');
const {bump} = require('../commands/bump.js');

const {assertProjectDir} = require('../utils/assert-project-dir.js');
const {batchTestGroup} = require('../utils/batch-test-group');
const bazelCmds = require('../utils/bazel-commands.js');
const {bazel, node, yarn} = require('../utils/binary-paths.js');
const {cli} = require('../utils/cli.js');
const {detectCyclicDeps} = require('../utils/detect-cyclic-deps.js');
const {
  exec,
  exists,
  read,
  write,
  ls,
  lstat,
} = require('../utils/node-helpers.js');
const {findChangedTargets} = require('../utils/find-changed-targets.js');
const {findLocalDependency} = require('../utils/find-local-dependency.js');
const {
  generateBazelBuildRules,
} = require('../utils/generate-bazel-build-rules.js');
const {generateBazelignore} = require('../utils/generate-bazelignore.js');
const {generateDepLockfiles} = require('../utils/generate-dep-lockfiles.js');
const {getChunkPattern} = require('../utils/get-chunk-pattern.js');
const {getDownstreams} = require('../utils/get-downstreams.js');
const {getManifest} = require('../utils/get-manifest.js');
const {getLocalDependencies} = require('../utils/get-local-dependencies.js');
const {getRootDir} = require('../utils/get-root-dir.js');
const {getTestGroups} = require('../utils/get-test-groups.js');
const {groupByDepsets} = require('../utils/group-by-depsets.js');
const {installDeps} = require('../utils/install-deps.js');
const {isDepsetSubset} = require('../utils/is-depset-subset.js');
const {isYarnResolution} = require('../utils/is-yarn-resolution.js');
const {parse, getPassThroughArgs} = require('../utils/parse-argv.js');

const {
  reportMismatchedTopLevelDeps,
} = require('../utils/report-mismatched-top-level-deps.js');
const {scaffold} = require('../utils/scaffold.js');
const {
  getCallArgItems,
  addCallArgItem,
  removeCallArgItem,
} = require('../utils/starlark.js');
const yarnCmds = require('../utils/yarn-commands.js');

process.on('unhandledRejection', e => {
  console.error(e.stack);
  process.exit(1);
});

runTests();

async function t(test) {
  const match = (process.argv[2] || '').toLowerCase();
  if (test.name.toLowerCase().indexOf(match) > -1) {
    if (match) console.log(`Testing ${test.name}`);
    return test();
  }
}

async function runTests() {
  await exec(`rm -rf ${__dirname}/tmp`);
  await exec(`mkdir -p ${__dirname}/tmp`);

  await Promise.all([
    t(testInstallAddUpgradeRemove),
    t(testCi),
    t(testDedupe),
    t(testUpgrade),
    t(testPurge),
    t(testYarn),
    t(testBump),
    t(testBazelDummy),
    t(testBazelBuild),
    t(testAssertProjectDir),
    t(testBatchTestGroup),
    t(testBinaryPaths),
    t(testCLI),
    t(testDetectCyclicDeps),
    t(testFindChangedTargets),
    t(testFindLocalDependency),
    t(testGenerateBazelignore),
    t(testGenerateBazelBuildRules),
    t(testGenerateBazelBuildRulesUpdate),
    t(testGenerateDepLockfiles),
    t(testGetChunkPattern),
    t(testGetDownstreams),
    t(testGetManifest),
    t(testGetLocalDependencies),
    t(testGetRootDir),
    t(testGetTestGroups),
    t(testGroupByDepsets),
    t(testInstallDeps),
    t(testIsDepsetSubset),
    t(testIsYarnResolution),
    t(testNodeHelpers),
    t(testParse),
    t(testGetPassThroughArgs),
    t(testReportMismatchedTopLevelDeps),
    t(testScaffold),
    t(testStarlark),
    t(testYarnCommands),
    t(testLockfileRegistryResolution),
    t(testLockfileRegistryResolutionMultirepo),
  ]);
  await t(testBin); // run separately to avoid CI error

  await exec(`rm -rf ${__dirname}/tmp`);

  console.log('All tests pass');
}

// commands
async function testInstallAddUpgradeRemove() {
  const buildFile = `${__dirname}/tmp/commands/a/BUILD.bazel`;
  const meta = `${__dirname}/tmp/commands/a/package.json`;

  // // install
  await exec(`cp -r ${__dirname}/fixtures/commands/ ${__dirname}/tmp/commands`);
  await install({
    root: `${__dirname}/tmp/commands`,
    cwd: `${__dirname}/tmp/commands/a`,
  });
  const binCmd = `${__dirname}/tmp/commands/node_modules/.bin/a`;
  const binScript = await read(binCmd, 'utf8');
  const bDep = `${__dirname}/tmp/commands/node_modules/b`;
  const bindDep = `${__dirname}/tmp/commands/node_modules/function-bind`;
  const downstreamLockfile = `${__dirname}/tmp/commands/downstream/yarn.lock`;
  const notDownstreamLockfile = `${__dirname}/tmp/commands/not-downstream/yarn.lock`;
  assert.equal(binScript, 'echo 1');
  assert(await exists(bDep));
  assert(await exists(bindDep));
  assert(await exists(downstreamLockfile));
  assert(!(await exists(notDownstreamLockfile)));

  // add linked package
  await add({
    root: `${__dirname}/tmp/commands`,
    cwd: `${__dirname}/tmp/commands/a`,
    name: 'c',
  });
  assert(await exists(`${__dirname}/tmp/commands/node_modules/c`));
  assert((await read(buildFile, 'utf8')).includes('//c:c'));

  // add external package
  await add({
    root: `${__dirname}/tmp/commands`,
    cwd: `${__dirname}/tmp/commands/a`,
    name: 'has@1.0.3',
  });
  assert(JSON.parse(await read(meta, 'utf8')).dependencies['has']);
  assert(await exists(`${__dirname}/tmp/commands/node_modules/has`));

  // upgrade linked package
  await upgrade({
    root: `${__dirname}/tmp/commands`,
    name: 'c@0.0.0',
  });
  assert(await exists(`${__dirname}/tmp/commands/node_modules/c`));
  assert((await read(buildFile, 'utf8')).includes('//c:c'));

  // upgrade external package
  await upgrade({
    root: `${__dirname}/tmp/commands`,
    name: 'has@1.0.3',
  });
  assert(JSON.parse(await read(meta, 'utf8')).dependencies['has']);
  assert(await exists(`${__dirname}/tmp/commands/node_modules/has`));

  // remove linked package
  await remove({
    root: `${__dirname}/tmp/commands`,
    cwd: `${__dirname}/tmp/commands/a`,
    name: 'c',
  });
  assert(!JSON.parse(await read(meta, 'utf8')).dependencies.c);
  assert(!(await exists(`${__dirname}/tmp/commands/node_modules/c`)));

  // remove external package
  await remove({
    root: `${__dirname}/tmp/commands`,
    cwd: `${__dirname}/tmp/commands/a`,
    name: 'has',
  });
  assert(!(await exists(`${__dirname}/tmp/commands/node_modules/has`)));
}

async function testCi() {
  const cmd = `cp -r ${__dirname}/fixtures/ci/ ${__dirname}/tmp/ci`;
  await exec(cmd);

  await ci({
    root: `${__dirname}/tmp/ci`,
    cwd: `${__dirname}/tmp/ci/b`,
  });
  assert(true); // did not throw
}

async function testDedupe() {
  const lockfile = `${__dirname}/tmp/dedupe/a/yarn.lock`;
  const cmd = `cp -r ${__dirname}/fixtures/dedupe/ ${__dirname}/tmp/dedupe`;
  await exec(cmd);

  await dedupe({
    root: `${__dirname}/tmp/dedupe`,
  });
  assert((await read(lockfile, 'utf8')).includes('version "1.0.3"'));
}

async function testUpgrade() {
  const meta = `${__dirname}/tmp/greenkeep/a/package.json`;
  const lockfile = `${__dirname}/tmp/greenkeep/a/yarn.lock`;
  const cmd = `cp -r ${__dirname}/fixtures/greenkeep/ ${__dirname}/tmp/greenkeep`;
  await exec(cmd);

  await upgrade({
    root: `${__dirname}/tmp/greenkeep`,
    name: 'is-number',
    from: '1.1.0',
  });
  assert((await read(meta, 'utf8')).includes('"is-number": "1.0.0"'));

  await upgrade({
    root: `${__dirname}/tmp/greenkeep`,
    name: 'b',
    from: '^0.0.1',
  });
  assert((await read(meta, 'utf8')).includes('"b": "0.0.0"'));

  await upgrade({
    root: `${__dirname}/tmp/greenkeep`,
    name: 'has@1.0.3',
  });
  assert((await read(meta, 'utf8')).includes('"has": "1.0.3"'));
  assert((await read(lockfile, 'utf8')).includes('function-bind'));

  await upgrade({root: `${__dirname}/tmp/greenkeep`, name: 'b'});
  assert((await read(meta, 'utf8')).includes('"b": "1.0.0"'));
}

async function testPurge() {
  await exec(`cp -r ${__dirname}/fixtures/purge/ ${__dirname}/tmp/purge`);
  await purge({root: `${__dirname}/tmp/purge`, fork: false});
  const nodeModules = `${__dirname}/tmp/purge/a/node_modules`;
  const globalNodeModules = `${__dirname}/tmp/purge/node_modules`;
  const temp = `${__dirname}/third_party/jazelle/temp`;
  assert(!(await exists(nodeModules)));
  assert(!(await exists(globalNodeModules)));
  assert(!(await exists(temp)));
}

async function testYarn() {
  await exec(`cp -r ${__dirname}/fixtures/yarn/ ${__dirname}/tmp/yarn`);

  const streamFile = `${__dirname}/tmp/yarn/stream.txt`;
  const stream = createWriteStream(streamFile);
  await new Promise(resolve => stream.on('open', resolve));
  await yarnCmd({
    cwd: `${__dirname}/tmp/yarn`,
    args: ['--help'],
    stdio: ['ignore', stream, stream],
  }).catch(() => {});
  assert((await read(streamFile, 'utf8')).includes('Usage:'));
}

async function testBump() {
  await exec(`cp -r ${__dirname}/fixtures/bump/ ${__dirname}/tmp/bump`);

  const root = `${__dirname}/tmp/bump`;
  const cwd = `${__dirname}/tmp/bump/not-a-real-project`;

  const pkgMeta = `${__dirname}/tmp/bump/not-a-real-project/package.json`;
  const depMeta = `${__dirname}/tmp/bump/not-a-real-dep/package.json`;
  const downstreamMeta = `${__dirname}/tmp/bump/not-a-real-downstream/package.json`;

  // do not update package.json files in CI
  // $FlowFixMe `assert` typedef is missing `rejects` method
  await assert.rejects(
    bump({root, cwd, type: 'preminor', frozenPackageJson: true})
  );
  assert(JSON.parse(await read(pkgMeta)).version, '0.0.0');
  assert(JSON.parse(await read(depMeta)).version, '0.0.0');

  await bump({root, cwd, type: 'preminor'});
  assert(JSON.parse(await read(pkgMeta)).version, '0.1.0-0');
  assert(JSON.parse(await read(depMeta)).version, '0.1.0-0');

  // command should be idempotent
  await bump({root, cwd, type: 'preminor'});
  assert(JSON.parse(await read(pkgMeta)).version, '0.1.0-0');
  assert(JSON.parse(await read(depMeta)).version, '0.1.0-0');

  // downstream is greenkept
  const meta = JSON.parse(await read(downstreamMeta));
  assert(meta.dependencies['not-a-real-project'], '0.1.0-0');
}

// utils
async function testAssertProjectDir() {
  const dir1 = `${__dirname}/fixtures/project-dir`;
  assert(await assertProjectDir({dir: dir1}).then(() => true, () => false));

  const dir2 = `${__dirname}/fixtures/not-project-dir`;
  assert(await assertProjectDir({dir: dir2}).then(() => false, () => true));
}

async function testBatchTestGroup() {
  const cmd = `cp -r ${__dirname}/fixtures/batch-test-group/ ${__dirname}/tmp/batch-test-group`;
  await exec(cmd);

  const streamFile = `${__dirname}/tmp/batch-test-group/stdout.txt`;
  const stream = createWriteStream(streamFile);
  await new Promise(resolve => stream.on('open', resolve));
  await install({
    root: `${__dirname}/tmp/batch-test-group`,
    cwd: `${__dirname}/tmp/batch-test-group/a`,
  });
  await install({
    root: `${__dirname}/tmp/batch-test-group`,
    cwd: `${__dirname}/tmp/batch-test-group/b`,
  });
  await install({
    root: `${__dirname}/tmp/batch-test-group`,
    cwd: `${__dirname}/tmp/batch-test-group/b`,
  });
  await batchTestGroup({
    root: `${__dirname}/tmp/batch-test-group`,
    data: [
      [
        {type: 'bazel', dir: 'a', action: 'flow'},
        {type: 'bazel', dir: 'a', action: 'lint'},
        {type: 'bazel', dir: 'a', action: 'test'},
      ],
      [
        {type: 'bazel', dir: 'b', action: 'lint'},
        {type: 'bazel', dir: 'b', action: 'test'},
        {type: 'bazel', dir: 'c', action: 'test'},
      ],
    ],
    index: 0,
    cores: 8,
    stdio: ['ignore', stream, stream],
  });
  const output = await read(streamFile, 'utf8');
  assert(output.includes('Analyzed target //a:test'));
  assert(output.includes('Analyzed target //a:lint'));
  assert(output.includes('Analyzed target //a:flow'));
  assert(!output.includes('//b:test'));
  assert(!output.includes('//b:lint'));
  assert(!output.includes('//c:test'));
}

async function testBazelDummy() {
  await exec(`cp -r ${__dirname}/fixtures/bazel/ ${__dirname}/tmp/bazel`);

  await bazelCmds.build({
    root: `${__dirname}/tmp/bazel`,
    cwd: `${__dirname}/tmp/bazel`,
    name: 'target',
  });
  const output = `${__dirname}/tmp/bazel/bazel-bin/target.sh`;
  assert.equal(await read(output, 'utf8'), 'echo target');

  const testStreamFile = `${__dirname}/tmp/bazel/test-stream.txt`;
  const testStream = createWriteStream(testStreamFile);
  await new Promise(resolve => testStream.on('open', resolve));
  await bazelCmds.test({
    root: `${__dirname}/tmp/bazel`,
    cwd: `${__dirname}/tmp/bazel`,
    args: [],
    name: 'target',
    stdio: ['ignore', testStream, 'ignore'],
  });
  assert((await read(testStreamFile, 'utf8')).includes('PASSED'));

  const runStreamFile = `${__dirname}/tmp/bazel/run-stream.txt`;
  const runStream = createWriteStream(runStreamFile);
  await new Promise(resolve => runStream.on('open', resolve));
  await bazelCmds.run({
    root: `${__dirname}/tmp/bazel`,
    cwd: `${__dirname}/tmp/bazel`,
    args: [],
    name: 'target',
    stdio: ['ignore', runStream, 'ignore'],
  });
  const msg = 'Executing tests from //:target';
  assert((await read(runStreamFile, 'utf8')).includes(msg));
}

async function testBazelBuild() {
  const cmd = `cp -r ${__dirname}/fixtures/bazel-rules/ ${__dirname}/tmp/bazel-rules`;
  await exec(cmd);
  await install({
    root: `${__dirname}/tmp/bazel-rules`,
    cwd: `${__dirname}/tmp/bazel-rules/projects/a`,
  });

  // build
  await bazelCmds.build({
    root: `${__dirname}/tmp/bazel-rules`,
    cwd: `${__dirname}/tmp/bazel-rules/projects/a`,
    name: 'a',
  });
  const output = `${__dirname}/tmp/bazel-rules/bazel-bin/projects/a/output.tgz`;
  assert(await exists(output));

  // test
  const testStreamFile = `${__dirname}/tmp/bazel-rules/test-stream.txt`;
  const testStream = createWriteStream(testStreamFile);
  await new Promise(resolve => testStream.on('open', resolve));
  await bazelCmds.test({
    root: `${__dirname}/tmp/bazel-rules`,
    cwd: `${__dirname}/tmp/bazel-rules/projects/a`,
    args: [],
    name: 'test',
    stdio: ['ignore', testStream, 'ignore'],
  });
  assert((await read(testStreamFile, 'utf8')).includes('PASSED'));

  // run
  const runStreamFile = `${__dirname}/tmp/bazel-rules/run-stream.txt`;
  const runStream = createWriteStream(runStreamFile);
  await new Promise(resolve => runStream.on('open', resolve));
  await bazelCmds.run({
    root: `${__dirname}/tmp/bazel-rules`,
    cwd: `${__dirname}/tmp/bazel-rules/projects/a`,
    args: [],
    name: 'test',
    stdio: ['ignore', runStream, 'ignore'],
  });
  assert((await read(runStreamFile, 'utf8')).includes('\nb\nv8.15.1'));

  // lint
  const lintStreamFile = `${__dirname}/tmp/bazel-rules/lint-stream.txt`;
  const lintStream = createWriteStream(lintStreamFile);
  await new Promise(resolve => lintStream.on('open', resolve));
  await bazelCmds.lint({
    root: `${__dirname}/tmp/bazel-rules`,
    cwd: `${__dirname}/tmp/bazel-rules/projects/a`,
    args: [],
    stdio: ['ignore', lintStream, 'ignore'],
  });
  assert((await read(lintStreamFile, 'utf8')).includes('\n111\n'));

  // flow
  const flowStreamFile = `${__dirname}/tmp/bazel-rules/flow-stream.txt`;
  const flowStream = createWriteStream(flowStreamFile);
  await new Promise(resolve => flowStream.on('open', resolve));
  await bazelCmds.flow({
    root: `${__dirname}/tmp/bazel-rules`,
    cwd: `${__dirname}/tmp/bazel-rules/projects/a`,
    args: [],
    stdio: ['ignore', flowStream, flowStream],
  });
  assert((await read(flowStreamFile, 'utf8')).includes('a:flow'));

  // start
  const startStreamFile = `${__dirname}/tmp/bazel-rules/start-stream.txt`;
  const startStream = createWriteStream(startStreamFile);
  await new Promise(resolve => startStream.on('open', resolve));
  await bazelCmds.start({
    root: `${__dirname}/tmp/bazel-rules`,
    cwd: `${__dirname}/tmp/bazel-rules/projects/a`,
    args: [],
    stdio: ['ignore', startStream, startStream],
  });
  assert((await read(startStreamFile, 'utf8')).includes('\n333\n'));
}

async function testBinaryPaths() {
  assert(await exists(bazel));
  assert(await exists(node));
  assert(await exists(yarn));
}

async function testCLI() {
  let called = '0';
  const cmds = {
    foo: [
      `Foo

      --bar [bar]     bar`,
      async ({bar}) => {
        called = bar;
      },
    ],
  };
  cli('foo', {bar: '1'}, cmds, async () => {});
  assert.equal(called, '1');
}

async function testDetectCyclicDeps() {
  const cycles = detectCyclicDeps({
    deps: [
      {
        dir: `${__dirname}/fixtures/detect-cyclic-deps/a`,
        meta: {
          name: 'a',
          version: '0.0.0',
          dependencies: {
            c: '0.0.0',
          },
        },
        lockfile: {},
        depth: 1,
      },
      {
        dir: `${__dirname}/fixtures/detect-cyclic-deps/b`,
        meta: {
          name: 'b',
          version: '0.0.0',
          dependencies: {
            a: '0.0.0',
          },
        },
        lockfile: {},
        depth: 2,
      },
      {
        dir: `${__dirname}/fixtures/detect-cyclic-deps/c`,
        meta: {
          name: 'c',
          version: '0.0.0',
          dependencies: {
            b: '0.0.0',
          },
        },
        lockfile: {},
        depth: 3,
      },
    ],
  });
  assert.equal(cycles.length, 1);

  const ok = detectCyclicDeps({
    deps: [
      {
        dir: `${__dirname}/fixtures/detect-cyclic-deps/a`,
        meta: {
          name: 'a',
          version: '0.0.0',
        },
        lockfile: {},
        depth: 1,
      },
      {
        dir: `${__dirname}/fixtures/detect-cyclic-deps/b`,
        meta: {
          name: 'b',
          version: '0.0.0',
          dependencies: {
            a: '0.0.0',
          },
        },
        lockfile: {},
        depth: 2,
      },
      {
        dir: `${__dirname}/fixtures/detect-cyclic-deps/c`,
        meta: {
          name: 'c',
          version: '0.0.0',
          dependencies: {
            b: '0.0.0',
          },
        },
        lockfile: {},
        depth: 3,
      },
    ],
  });
  assert.equal(ok.length, 0);
}

async function testFindChangedTargets() {
  {
    const root = `${__dirname}/fixtures/find-changed-targets/dirs`;
    const files = `${__dirname}/fixtures/find-changed-targets/dirs/changes.txt`;
    const dirs = await findChangedTargets({root, files});
    assert.deepEqual(dirs, ['b', 'a']);
  }
  {
    const cmd = `cp -r ${__dirname}/fixtures/find-changed-targets/ ${__dirname}/tmp/find-changed-targets`;
    await exec(cmd);

    const root = `${__dirname}/tmp/find-changed-targets/bazel`;
    const files = `${__dirname}/tmp/find-changed-targets/bazel/changes.txt`;
    await install({
      root: `${__dirname}/tmp/find-changed-targets/bazel`,
      cwd: `${__dirname}/tmp/find-changed-targets/bazel/a`,
    });
    await install({
      root: `${__dirname}/tmp/find-changed-targets/bazel`,
      cwd: `${__dirname}/tmp/find-changed-targets/bazel/b`,
    });
    await install({
      root: `${__dirname}/tmp/find-changed-targets/bazel`,
      cwd: `${__dirname}/tmp/find-changed-targets/bazel/c`,
    });
    const targets = await findChangedTargets({root, files});
    assert.deepEqual(targets, [
      '//b:test',
      '//b:lint',
      '//b:flow',
      '//a:test',
      '//a:lint',
      '//a:flow',
    ]);
  }
}

async function testFindLocalDependency() {
  const found = await findLocalDependency({
    root: `${__dirname}/fixtures/find-local-dependency`,
    name: 'a',
  });
  const meta = `${__dirname}/fixtures/find-local-dependency/a/package.json`;
  assert.deepEqual(found.meta, JSON.parse(await read(meta, 'utf8')));

  const notFound = await findLocalDependency({
    root: `${__dirname}/fixtures/find-local-dependency`,
    name: 'non-existent',
  });
  assert.deepEqual(notFound, undefined);
}

async function testGenerateBazelignore() {
  const cmd = `cp -r ${__dirname}/fixtures/generate-bazelignore/ ${__dirname}/tmp/generate-bazelignore`;
  await exec(cmd);
  await generateBazelignore({
    root: `${__dirname}/tmp/generate-bazelignore`,
    projects: ['a', 'b'],
  });
  const bazelignoreFile = `${__dirname}/tmp/generate-bazelignore/.bazelignore`;
  const bazelignore = await read(bazelignoreFile, 'utf8');
  assert(bazelignore.includes('a/node_modules'));
  assert(bazelignore.includes('b/node_modules'));
}

async function testGenerateBazelBuildRules() {
  const cmd = `cp -r ${__dirname}/fixtures/generate-bazel-build-rules/ ${__dirname}/tmp/generate-bazel-build-rules`;
  await exec(cmd);
  await generateBazelBuildRules({
    root: `${__dirname}/tmp/generate-bazel-build-rules`,
    deps: [
      {
        meta: JSON.parse(
          await read(
            `${__dirname}/tmp/generate-bazel-build-rules/a/package.json`,
            'utf8'
          )
        ),
        dir: `${__dirname}/tmp/generate-bazel-build-rules/a`,
        depth: 2,
      },
      {
        meta: JSON.parse(
          await read(
            `${__dirname}/tmp/generate-bazel-build-rules/b/package.json`,
            'utf8'
          )
        ),
        dir: `${__dirname}/tmp/generate-bazel-build-rules/b`,
        depth: 1,
      },
    ],
    projects: ['a', 'b', 'c', 'd'],
  });
  const code = await read(
    `${__dirname}/tmp/generate-bazel-build-rules/a/BUILD.bazel`,
    'utf8'
  );
  assert(code.includes('# name: a\n'));
  assert(code.includes('# path: a\n'));
  assert(code.includes('# label: //a:a\n'));
  assert(code.includes('# dependencies: //b:b\n'));
  const bBuild = `${__dirname}/tmp/generate-bazel-build-rules/b/BUILD.bazel`;
  const cBuild = `${__dirname}/tmp/generate-bazel-build-rules/c/BUILD.bazel`;
  const dBuild = `${__dirname}/tmp/generate-bazel-build-rules/d/BUILD.bazel`;
  assert(await exists(bBuild));
  assert((await read(cBuild)).includes('# this file'));
  assert(!(await exists(dBuild)));
}

async function testGenerateBazelBuildRulesUpdate() {
  const cmd = `cp -r ${__dirname}/fixtures/generate-bazel-build-rules-update/ ${__dirname}/tmp/generate-bazel-build-rules-update`;
  await exec(cmd);
  await generateBazelBuildRules({
    root: `${__dirname}/tmp/generate-bazel-build-rules-update`,
    deps: [
      {
        meta: JSON.parse(
          await read(
            `${__dirname}/tmp/generate-bazel-build-rules-update/a/package.json`,
            'utf8'
          )
        ),
        dir: `${__dirname}/tmp/generate-bazel-build-rules-update/a`,
        depth: 2,
      },
      {
        meta: JSON.parse(
          await read(
            `${__dirname}/tmp/generate-bazel-build-rules-update/b/package.json`,
            'utf8'
          )
        ),
        dir: `${__dirname}/tmp/generate-bazel-build-rules-update/b`,
        depth: 1,
      },
    ],
    projects: ['a', 'b', 'c'],
  });
  const aBuild = `${__dirname}/tmp/generate-bazel-build-rules-update/a/BUILD.bazel`;
  const data = await read(aBuild);
  assert(data.includes('//b:b'));
  assert(!data.includes('//c:c'));
  assert(data.includes('//external:external'));
}

async function testGenerateDepLockfiles() {
  const cmd = `cp -r ${__dirname}/fixtures/generate-dep-lockfiles/ ${__dirname}/tmp/generate-dep-lockfiles`;
  await exec(cmd);
  await generateDepLockfiles({
    root: `${__dirname}/tmp/generate-dep-lockfiles`,
    deps: [
      {
        meta: JSON.parse(
          await read(
            `${__dirname}/tmp/generate-dep-lockfiles/a/package.json`,
            'utf8'
          )
        ),
        dir: `${__dirname}/tmp/generate-dep-lockfiles/a`,
        depth: 1,
      },
    ],
    ignore: [
      {
        meta: JSON.parse(
          await read(
            `${__dirname}/tmp/generate-dep-lockfiles/a/package.json`,
            'utf8'
          )
        ),
        dir: `${__dirname}/tmp/generate-dep-lockfiles/a`,
        depth: 1,
      },
    ],
  });
  const lockfile = `${__dirname}/tmp/generate-dep-lockfiles/a/yarn.lock`;
  assert((await read(lockfile, 'utf8')).includes('has@'));
}

async function testGetChunkPattern() {
  const cmd = `cp -r ${__dirname}/fixtures/get-chunk-pattern/ ${__dirname}/tmp/get-chunk-pattern`;
  await exec(cmd);
  assert.equal(
    await getChunkPattern({
      root: `${__dirname}/fixtures/get-chunk-pattern`,
      patterns: ['tests/**/*', '!tests/fixtures/**/*'],
      jobs: 2,
      index: 0,
    }),
    '.*/tests/test-1.js|.*/tests/test-3.js'
  );

  assert.equal(
    await getChunkPattern({
      root: `${__dirname}/fixtures/get-chunk-pattern`,
      patterns: ['tests/**/*', '!tests/fixtures/**/*'],
      jobs: 2,
      index: 1,
    }),
    '.*/tests/test-2.js'
  );

  assert.equal(
    await getChunkPattern({
      root: `${__dirname}/fixtures/get-chunk-pattern`,
      patterns: ['tests/**/*', '!tests/fixtures/**/*'],
      jobs: 4,
      index: 3,
    }),
    ''
  );
}

async function testGetDownstreams() {
  const deps = [
    {
      dir: `${__dirname}/tmp/get-downstreams/a`,
      meta: {
        name: 'a',
        version: '0.0.0',
        dependencies: {b: '0.0.0'}, // cyclical dep should not break test
      },
      depth: 3,
    },
    {
      dir: `${__dirname}/tmp/get-downstreams/b`,
      meta: {
        name: 'b',
        version: '0.0.0',
        dependencies: {a: '0.0.0'},
      },
      depth: 2,
    },
    {
      dir: `${__dirname}/tmp/get-downstreams/c`,
      meta: {
        name: 'c',
        version: '0.0.0',
        dependencies: {b: '0.0.0'},
      },
      depth: 1,
    },
  ];
  const downstreams = getDownstreams(deps, deps[0]);
  assert.deepEqual(downstreams, deps.slice(1));
}

async function testGetLocalDependencies() {
  const cmd = `cp -r ${__dirname}/fixtures/get-local-dependencies/ ${__dirname}/tmp/get-local-dependencies`;
  await exec(cmd);
  const localDeps = await getLocalDependencies({
    dirs: [
      `${__dirname}/tmp/get-local-dependencies/a`,
      `${__dirname}/tmp/get-local-dependencies/b`,
      `${__dirname}/tmp/get-local-dependencies/c`,
    ],
    target: `${__dirname}/tmp/get-local-dependencies/a`,
  });
  assert.deepEqual(localDeps, [
    {
      meta: JSON.parse(
        await read(
          `${__dirname}/tmp/get-local-dependencies/b/package.json`,
          'utf8'
        )
      ),
      dir: `${__dirname}/tmp/get-local-dependencies/b`,
      depth: 2,
    },
    {
      meta: JSON.parse(
        await read(
          `${__dirname}/tmp/get-local-dependencies/a/package.json`,
          'utf8'
        )
      ),
      dir: `${__dirname}/tmp/get-local-dependencies/a`,
      depth: 1,
    },
  ]);
}

async function testGetManifest() {
  assert.deepEqual(
    await getManifest({root: `${__dirname}/fixtures/get-all-project-paths`}),
    {
      projects: ['path/to/a', 'path/to/b'],
      workspace: 'host',
    }
  );
}

async function testGetRootDir() {
  const dir = `${__dirname}/fixtures/get-root-dir/a`;
  assert(await getRootDir({dir}).then(() => true, () => false));
}

async function testGetTestGroups() {
  const cmd = `cp -r ${__dirname}/fixtures/get-test-groups/ ${__dirname}/tmp/get-test-groups`;
  await exec(cmd);

  const bazelByTwo = await getTestGroups({
    root: `${__dirname}/tmp/get-test-groups`,
    data: [
      `//a:test`,
      `//a:lint`,
      `//a:flow`,
      `//b:test`,
      `//b:lint`,
      `//c:test`,
    ],
    nodes: 2,
  });
  assert.deepEqual(bazelByTwo, [
    [
      {type: 'bazel', dir: 'a', action: 'test'},
      {type: 'bazel', dir: 'a', action: 'lint'},
      {type: 'bazel', dir: 'a', action: 'flow'},
    ],
    [
      {type: 'bazel', dir: 'b', action: 'test'},
      {type: 'bazel', dir: 'b', action: 'lint'},
      {type: 'bazel', dir: 'c', action: 'test'},
    ],
  ]);

  const bazelByFour = await getTestGroups({
    root: `${__dirname}/tmp/get-test-groups`,
    data: [
      `//a:test`,
      `//a:lint`,
      `//a:flow`,
      `//b:test`,
      `//b:lint`,
      `//c:test`,
    ],
    nodes: 4,
  });
  assert.deepEqual(bazelByFour, [
    [
      {type: 'bazel', dir: 'a', action: 'lint'},
      {type: 'bazel', dir: 'a', action: 'flow'},
    ],
    [{type: 'bazel', dir: 'a', action: 'test'}],
    [
      {type: 'bazel', dir: 'b', action: 'test'},
      {type: 'bazel', dir: 'b', action: 'lint'},
    ],
    [{type: 'bazel', dir: 'c', action: 'test'}],
  ]);

  const bazelByEight = await getTestGroups({
    root: `${__dirname}/tmp/get-test-groups`,
    data: [
      `//a:test`,
      `//a:lint`,
      `//a:flow`,
      `//b:test`,
      `//b:lint`,
      `//c:test`,
    ],
    nodes: 8,
  });
  assert.deepEqual(bazelByEight, [
    [{type: 'bazel', dir: 'a', action: 'flow'}],
    [{type: 'bazel', dir: 'a', action: 'lint'}],
    [{type: 'bazel', dir: 'a', action: 'test'}],
    [{type: 'bazel', dir: 'b', action: 'lint'}],
    [{type: 'bazel', dir: 'b', action: 'test'}],
    [{type: 'bazel', dir: 'c', action: 'test'}],
  ]);

  const dirByTwo = await getTestGroups({
    root: `${__dirname}/tmp/get-test-groups`,
    data: [`a`, 'b', 'c'],
    nodes: 2,
  });
  assert.deepEqual(dirByTwo, [
    [
      {type: 'dir', dir: 'a', action: 'test'},
      {type: 'dir', dir: 'a', action: 'lint'},
      {type: 'dir', dir: 'a', action: 'flow'},
    ],
    [
      {type: 'dir', dir: 'b', action: 'test'},
      {type: 'dir', dir: 'b', action: 'lint'},
      {type: 'dir', dir: 'c', action: 'test'},
    ],
  ]);

  const dirByFour = await getTestGroups({
    root: `${__dirname}/tmp/get-test-groups`,
    data: [`a`, 'b', 'c'],
    nodes: 4,
  });
  assert.deepEqual(dirByFour, [
    [
      {type: 'dir', dir: 'a', action: 'lint'},
      {type: 'dir', dir: 'a', action: 'flow'},
    ],
    [{type: 'dir', dir: 'a', action: 'test'}],
    [
      {type: 'dir', dir: 'b', action: 'test'},
      {type: 'dir', dir: 'b', action: 'lint'},
    ],
    [{type: 'dir', dir: 'c', action: 'test'}],
  ]);
}

async function testGroupByDepsets() {
  const cmd = `cp -r ${__dirname}/fixtures/group-by-depsets/ ${__dirname}/tmp/group-by-depsets`;
  await exec(cmd);

  const root = `${__dirname}/tmp/group-by-depsets`;
  const aMeta = JSON.parse(await read(`${root}/a/package.json`, 'utf8'));
  const bMeta = JSON.parse(await read(`${root}/b/package.json`, 'utf8'));
  const cMeta = JSON.parse(await read(`${root}/c/package.json`, 'utf8'));
  const metas = [
    {dir: `${root}/a`, depth: 0, meta: aMeta},
    {dir: `${root}/b`, depth: 0, meta: bMeta},
    {dir: `${root}/c`, depth: 0, meta: cMeta},
  ];
  const group = [
    {type: 'bazel', dir: 'a', action: 'test'},
    {type: 'bazel', dir: 'a', action: 'lint'},
    {type: 'bazel', dir: 'a', action: 'flow'},
    {type: 'bazel', dir: 'b', action: 'test'},
    {type: 'bazel', dir: 'b', action: 'lint'},
    {type: 'bazel', dir: 'b', action: 'flow'},
    {type: 'bazel', dir: 'c', action: 'test'},
    {type: 'bazel', dir: 'c', action: 'lint'},
    {type: 'bazel', dir: 'c', action: 'flow'},
  ];
  assert.deepEqual(groupByDepsets({root, metas, group}), [
    [
      {type: 'bazel', dir: 'a', action: 'test'},
      {type: 'bazel', dir: 'a', action: 'lint'},
      {type: 'bazel', dir: 'a', action: 'flow'},
      {type: 'bazel', dir: 'b', action: 'test'},
      {type: 'bazel', dir: 'b', action: 'lint'},
      {type: 'bazel', dir: 'b', action: 'flow'},
    ],
    [
      {type: 'bazel', dir: 'c', action: 'test'},
      {type: 'bazel', dir: 'c', action: 'lint'},
      {type: 'bazel', dir: 'c', action: 'flow'},
    ],
  ]);
}

async function testInstallDeps() {
  const cmd = `cp -r ${__dirname}/fixtures/install-deps/ ${__dirname}/tmp/install-deps`;
  await exec(cmd);
  const deps = {
    root: `${__dirname}/tmp/install-deps`,
    cwd: `${__dirname}/tmp/install-deps/a`,
    deps: [
      {
        meta: JSON.parse(
          await read(`${__dirname}/tmp/install-deps/b/package.json`, 'utf8')
        ),
        dir: `${__dirname}/tmp/install-deps/b`,
        depth: 2,
      },
      {
        meta: JSON.parse(
          await read(`${__dirname}/tmp/install-deps/a/package.json`, 'utf8')
        ),
        dir: `${__dirname}/tmp/install-deps/a`,
        depth: 1,
      },
    ],
    ignore: [
      {
        meta: JSON.parse(
          await read(`${__dirname}/tmp/install-deps/b/package.json`, 'utf8')
        ),
        dir: `${__dirname}/tmp/install-deps/b`,
        depth: 2,
      },
      {
        meta: JSON.parse(
          await read(`${__dirname}/tmp/install-deps/a/package.json`, 'utf8')
        ),
        dir: `${__dirname}/tmp/install-deps/a`,
        depth: 1,
      },
    ],
  };
  await installDeps(deps);
  assert(await exists(`${__dirname}/tmp/install-deps/node_modules/b`));
  assert(await exists(`${__dirname}/tmp/install-deps/node_modules/noop`));
}

async function testIsDepsetSubset() {
  const base = {name: '', version: ''};
  {
    const it = {...base, dependencies: {a: '^1.0.0'}};
    const of = {...base, dependencies: {a: '^1.0.3'}};
    assert(isDepsetSubset({of, it}));
  }
  {
    const it = {...base, dependencies: {a: '^1.2.3'}};
    const of = {...base, dependencies: {a: '^1.0.0'}};
    assert(isDepsetSubset({of, it}));
  }
  {
    const it = {...base, dependencies: {a: '^1.0.0'}};
    const of = {...base, dependencies: {a: '^1.0.0', b: '1.0.0'}};
    assert(isDepsetSubset({of, it}));
  }
  {
    const it = {...base, dependencies: {a: '^1.0.0', b: '1.0.0'}};
    const of = {...base, dependencies: {a: '^1.0.0'}};
    assert(!isDepsetSubset({of, it}));
  }
  {
    const it = {...base, dependencies: {a: '^1.2.3'}};
    const of = {...base, dependencies: {a: '^2.0.0'}};
    assert(!isDepsetSubset({of, it}));
  }
  {
    const it = {...base, dependencies: {b: '^1.0.0'}};
    const of = {...base, dependencies: {a: '^1.0.0'}};
    assert(!isDepsetSubset({of, it}));
  }
  {
    const it = {...base, dependencies: {a: 'npm:foo@0.0.0'}};
    const of = {...base, dependencies: {a: 'npm:bar@0.0.0'}};
    assert(!isDepsetSubset({of, it}));
  }
  {
    const it = {...base, dependencies: {a: '0.0.0'}};
    const of = {...base, dependencies: {a: 'npm:bar@0.0.0'}};
    assert(!isDepsetSubset({of, it}));
  }
}

async function testIsYarnResolution() {
  const exact = isYarnResolution({
    meta: {resolutions: {a: '0.0.0'}, name: '', version: ''},
    name: 'a',
  });
  assert.equal(exact, true);

  const namespaced = isYarnResolution({
    meta: {resolutions: {'@a/b': '0.0.0'}, name: '', version: ''},
    name: '@a/b',
  });
  assert.equal(namespaced, true);

  const globbed = isYarnResolution({
    meta: {resolutions: {'**/a': '0.0.0'}, name: '', version: ''},
    name: 'a',
  });
  assert.equal(globbed, true);

  const globbedNs = isYarnResolution({
    meta: {resolutions: {'**/@a/b': '0.0.0'}, name: '', version: ''},
    name: '@a/b',
  });
  assert.equal(globbedNs, true);

  const direct = isYarnResolution({
    meta: {resolutions: {'a/b': '0.0.0'}, name: '', version: ''},
    name: 'b',
  });
  assert.equal(direct, true);

  const directNs = isYarnResolution({
    meta: {resolutions: {'a/@b/c': '0.0.0'}, name: '', version: ''},
    name: '@b/c',
  });
  assert.equal(directNs, true);

  const directOfNs = isYarnResolution({
    meta: {resolutions: {'@a/b/c': '0.0.0'}, name: '', version: ''},
    name: 'c',
  });
  assert.equal(directOfNs, true);

  const directNsOfNs = isYarnResolution({
    meta: {resolutions: {'@a/b/@c/d': '0.0.0'}, name: '', version: ''},
    name: '@c/d',
  });
  assert.equal(directNsOfNs, true);

  const transitive = isYarnResolution({
    meta: {resolutions: {'a/**/b': '0.0.0'}, name: '', version: ''},
    name: 'b',
  });
  assert.equal(transitive, true);

  const transitiveNs = isYarnResolution({
    meta: {resolutions: {'a/**/@b/c': '0.0.0'}, name: '', version: ''},
    name: '@b/c',
  });
  assert.equal(transitiveNs, true);

  const transitiveOfNs = isYarnResolution({
    meta: {resolutions: {'@a/b/**/c': '0.0.0'}, name: '', version: ''},
    name: 'c',
  });
  assert.equal(transitiveOfNs, true);

  const transitiveNsOfNs = isYarnResolution({
    meta: {resolutions: {'@a/b/**/@c/d': '0.0.0'}, name: '', version: ''},
    name: '@c/d',
  });
  assert.equal(transitiveNsOfNs, true);

  const nested = isYarnResolution({
    meta: {resolutions: {'a/b/c': '0.0.0'}, name: '', version: ''},
    name: 'c',
  });
  assert.equal(nested, true);

  const nestedOfNs = isYarnResolution({
    meta: {resolutions: {'a/@b/c/d': '0.0.0'}, name: '', version: ''},
    name: 'd',
  });
  assert.equal(nestedOfNs, true);

  const positional = isYarnResolution({
    meta: {resolutions: {'a/b': '0.0.0'}, name: '', version: ''},
    name: 'a',
  });
  assert.equal(positional, false);

  const positionalNs = isYarnResolution({
    meta: {resolutions: {'@a/a/b': '0.0.0'}, name: '', version: ''},
    name: 'a',
  });
  assert.equal(positionalNs, false);
}

async function testNodeHelpers() {
  const cmd = `cp -r ${__dirname}/fixtures/node-helpers/ ${__dirname}/tmp/node-helpers`;
  await exec(cmd);
  assert.equal(await exec('echo abc'), 'abc\n');
  assert(await exists(__filename));
  const files = await ls(`${__dirname}/fixtures/node-helpers`);
  assert.deepEqual(files, ['file.txt']);
  const file = `${__dirname}/tmp/node-helpers/file.txt`;
  await write(file, 'hello', 'utf8');
  const text = readFileSync(file, 'utf8');
  assert.equal(await read(file, 'utf8'), text);
  assert.equal(text, 'hello');
  const stats = await lstat(`${__dirname}/tmp/node-helpers/file.txt`);
  assert.equal(stats.isFile(), true);
}

async function testParse() {
  assert.deepEqual(parse(['hello', '--foo', '111', '--bar=222', '--baz']), {
    name: 'hello',
    foo: '111',
    bar: '222',
    baz: true,
  });
}

async function testGetPassThroughArgs() {
  const args = getPassThroughArgs(['--cwd', '/foo', '--a', '--b', 'b', 'c']);
  assert.deepEqual(args, ['--a', '--b', 'b', 'c']);
}

async function testReportMismatchedTopLevelDeps() {
  const cmd = `cp -r ${__dirname}/fixtures/report-mismatched-top-level-deps/ ${__dirname}/tmp/report-mismatched-top-level-deps`;
  await exec(cmd);
  const result = await reportMismatchedTopLevelDeps({
    root: `${__dirname}/tmp/report-mismatched-top-level-deps`,
    projects: ['packages/a', 'packages/b', 'packages/c'],
    versionPolicy: {
      lockstep: false,
      exceptions: ['no-bugs', '@uber/mismatched'],
    },
  });

  assert.deepEqual(result, {
    valid: false,
    policy: {lockstep: false, exceptions: ['no-bugs', '@uber/mismatched']},
    reported: {
      'no-bugs': {
        '^1.0.0': ['@uber/a', '@uber/b'],
        'npm:function-bind': ['@uber/c'],
      },
      '@uber/mismatched': {'^2.0.0': ['@uber/b'], '^1.0.0': ['@uber/a']},
    },
  });

  const withLockstep = await reportMismatchedTopLevelDeps({
    root: `${__dirname}/tmp/report-mismatched-top-level-deps`,
    projects: ['packages/a', 'packages/b', 'packages/c'],
    versionPolicy: {
      lockstep: true,
      exceptions: ['no-bugs'],
    },
  });
  assert.deepEqual(withLockstep, {
    valid: false,
    policy: {lockstep: true, exceptions: ['no-bugs']},
    reported: {
      '@uber/mismatched': {'^2.0.0': ['@uber/b'], '^1.0.0': ['@uber/a']},
    },
  });

  const withAllExceptions = await reportMismatchedTopLevelDeps({
    root: `${__dirname}/tmp/report-mismatched-top-level-deps`,
    projects: ['packages/a', 'packages/b', 'packages/c'],
    versionPolicy: {
      lockstep: true,
      exceptions: ['no-bugs', '@uber/mismatched'],
    },
  });
  assert.deepEqual(withAllExceptions, {
    valid: true,
    policy: {lockstep: true, exceptions: ['no-bugs', '@uber/mismatched']},
    reported: {},
  });
}

async function testScaffold() {
  await exec(`mkdir ${__dirname}/tmp/scaffold`);
  await scaffold({cwd: `${__dirname}/tmp/scaffold`});
  assert(await exists(`${__dirname}/tmp/scaffold/WORKSPACE`));
  assert(await exists(`${__dirname}/tmp/scaffold/BUILD.bazel`));
  assert(await exists(`${__dirname}/tmp/scaffold/.bazelversion`));
  assert(await exists(`${__dirname}/tmp/scaffold/manifest.json`));
  assert(await exists(`${__dirname}/tmp/scaffold/.gitignore`));
}

async function testStarlark() {
  await exec(`cp -r ${__dirname}/fixtures/starlark/ ${__dirname}/tmp/starlark`);
  const buildFile = `${__dirname}/tmp/starlark/indented/BUILD.bazel`;
  const indented = await read(buildFile, 'utf8');
  assert.deepEqual(getCallArgItems(indented, 'web_library', 'deps'), [
    '"//a:a"',
    '"//b:b"',
  ]);

  const indentedWithAddedDep = addCallArgItem(
    indented,
    'web_library',
    'deps',
    '"//c:c"'
  );
  assert.equal(
    indentedWithAddedDep.trim(),
    `
web_library(
  name = "foo",
  deps = [
    "//a:a",
    "//b:b",
    "//c:c",
  ]
)
  `.trim()
  );

  const indentedWithRemovedDep = removeCallArgItem(
    indentedWithAddedDep,
    'web_library',
    'deps',
    '"//b:b"'
  );
  assert.equal(
    indentedWithRemovedDep.trim(),
    `
web_library(
  name = "foo",
  deps = [
    "//a:a",
    "//c:c",
  ]
)
  `.trim()
  );

  const inline = await read(
    `${__dirname}/tmp/starlark/inline/BUILD.bazel`,
    'utf8'
  );
  const inlineWithAddedDep = addCallArgItem(
    inline,
    'web_library',
    'deps',
    '"//c:c"'
  );
  assert.equal(
    inlineWithAddedDep.trim(),
    `
web_library(
  name = "foo",
  deps = ["//a:a", "//b:b", "//c:c"]
)
  `.trim()
  );

  const commented = await read(
    `${__dirname}/tmp/starlark/comments/BUILD.bazel`,
    'utf8'
  );
  const commentedWithAddedDep = addCallArgItem(
    commented,
    'web_library',
    'deps',
    '"//c:c"'
  );
  assert.equal(
    commentedWithAddedDep
      .split('\n')
      .map(l => l.replace(/\s+$/, ''))
      .join('\n')
      .trim(),
    `
web_library(    # comment
  name = "foo", # comment
  deps = [
    "//a:a",
    "//b:b",
    "//c:c",
  ]             # comment
)               # comment
  `.trim()
  );

  const commentedWithRemovedDep = removeCallArgItem(
    commentedWithAddedDep,
    'web_library',
    'deps',
    '"//b:b"'
  );
  assert.equal(
    commentedWithRemovedDep
      .split('\n')
      .map(l => l.replace(/\s+$/, ''))
      .join('\n')
      .trim(),
    `
web_library(    # comment
  name = "foo", # comment
  deps = [
    "//a:a",
    "//c:c",
  ]             # comment
)               # comment
  `.trim()
  );
}

async function testYarnCommands() {
  const cmd = `cp -r ${__dirname}/fixtures/yarn-commands ${__dirname}/tmp/yarn-commands`;
  await exec(cmd);
  const deps = [
    {
      dir: `${__dirname}/tmp/yarn-commands/a`,
      meta: JSON.parse(
        await read(`${__dirname}/tmp/yarn-commands/a/package.json`, 'utf8')
      ),
      depth: 1,
    },
  ];
  const root = `${__dirname}/tmp/yarn-commands`;

  // build
  const buildStreamFile = `${__dirname}/tmp/yarn-commands/build-stream.txt`;
  const buildStream = createWriteStream(buildStreamFile);
  await new Promise(resolve => buildStream.on('open', resolve));
  await yarnCmds.build({
    root,
    deps,
    stdio: ['ignore', buildStream, 'ignore'],
  });
  // build twice to check that it cached
  await yarnCmds.build({
    root,
    deps,
    stdio: ['ignore', buildStream, 'ignore'],
  });
  assert((await read(buildStreamFile, 'utf8')).match(/\n111\n/g).length === 1);

  // dev
  const devStreamFile = `${__dirname}/tmp/yarn-commands/dev-stream.txt`;
  const devStream = createWriteStream(devStreamFile);
  await new Promise(resolve => devStream.on('open', resolve));
  await yarnCmds.dev({
    root,
    deps,
    args: [],
    stdio: ['ignore', devStream, 'ignore'],
  });
  assert((await read(devStreamFile, 'utf8')).includes('\n333\n'));

  // test
  const testStreamFile = `${__dirname}/tmp/yarn-commands/test-stream.txt`;
  const testStream = createWriteStream(testStreamFile);
  await new Promise(resolve => testStream.on('open', resolve));
  await yarnCmds.test({
    root,
    deps,
    args: [],
    stdio: ['ignore', testStream, 'ignore'],
  });
  assert((await read(testStreamFile, 'utf8')).includes('\n444\n'));

  // lint
  const lintStreamFile = `${__dirname}/tmp/yarn-commands/lint-stream.txt`;
  const lintStream = createWriteStream(lintStreamFile);
  await new Promise(resolve => lintStream.on('open', resolve));
  await yarnCmds.lint({
    root,
    deps,
    args: [],
    stdio: ['ignore', lintStream, 'ignore'],
  });
  assert((await read(lintStreamFile, 'utf8')).includes('\n555\n'));

  // flow
  const flowStreamFile = `${__dirname}/tmp/yarn-commands/flow-stream.txt`;
  const flowStream = createWriteStream(flowStreamFile);
  await new Promise(resolve => flowStream.on('open', resolve));
  await yarnCmds.flow({
    root,
    deps,
    args: [],
    stdio: ['ignore', flowStream, 'ignore'],
  });
  assert((await read(flowStreamFile, 'utf8')).includes('\n666\n'));

  // start
  const startStreamFile = `${__dirname}/tmp/yarn-commands/start-stream.txt`;
  const startStream = createWriteStream(startStreamFile);
  await new Promise(resolve => startStream.on('open', resolve));
  await yarnCmds.start({
    root,
    deps,
    args: [],
    stdio: ['ignore', startStream, 'ignore'],
  });
  assert((await read(startStreamFile, 'utf8')).includes('\n777\n'));
}
async function testBin() {
  const cmd = `cp -r ${__dirname}/fixtures/bin ${__dirname}/tmp/bin`;
  await exec(cmd);

  const cwd = `${__dirname}/tmp/bin`;
  const jazelle = `${__dirname}/../bin/cli.sh`;

  const streamFile = `${__dirname}/tmp/bin/stream.txt`;
  const stream = createWriteStream(streamFile);
  await new Promise(resolve => stream.on('open', resolve));
  await exec(`${jazelle}`, {cwd}, [stream, stream]);
  assert((await read(streamFile, 'utf8')).includes('Usage: jazelle [command]'));

  const yarnStreamFile = `${__dirname}/tmp/bin/yarn-stream.txt`;
  const yarnStream = createWriteStream(yarnStreamFile);
  await new Promise(resolve => yarnStream.on('open', resolve));
  await exec(`${jazelle} yarn --version --cwd a`, {cwd}, [yarnStream]);
  assert((await read(yarnStreamFile, 'utf8')).includes('.'));

  const cwdStreamFile = `${__dirname}/tmp/bin/cwd-stream.txt`;
  const cwdStream = createWriteStream(cwdStreamFile);
  await new Promise(resolve => cwdStream.on('open', resolve));
  await exec(`${jazelle} yarn --version`, {cwd: `${cwd}/a`}, [cwdStream]);
  assert((await read(cwdStreamFile, 'utf8')).includes('.'));

  const bazelStreamFile = `${__dirname}/tmp/bin/bazel-stream.txt`;
  const bazelStream = createWriteStream(bazelStreamFile);
  await new Promise(resolve => bazelStream.on('open', resolve));
  await exec(`${jazelle} bazel version`, {cwd}, [bazelStream]);
  assert((await read(bazelStreamFile, 'utf8')).includes('Bazelisk version:'));

  const startStreamFile = `${__dirname}/tmp/bin/start-stream.txt`;
  const startStream = createWriteStream(startStreamFile);
  await new Promise(resolve => startStream.on('open', resolve));
  await exec(`${jazelle} start`, {cwd: `${cwd}/a`}, [startStream]);
  assert((await read(startStreamFile, 'utf8')).includes('\nstart\n'));
}

async function testLockfileRegistryResolution() {
  const cmd = `cp -r ${__dirname}/fixtures/lockfile-registry-resolution/ ${__dirname}/tmp/lockfile-registry-resolution`;
  await exec(cmd);
  await install({
    root: `${__dirname}/tmp/lockfile-registry-resolution`,
    cwd: `${__dirname}/tmp/lockfile-registry-resolution/a`,
  });
  assert(
    (await read(
      `${__dirname}/tmp/lockfile-registry-resolution/b/yarn.lock`,
      'utf8'
    )).includes('registry.yarnpkg.com')
  );
  assert(
    (await read(
      `${__dirname}/tmp/lockfile-registry-resolution/c/yarn.lock`,
      'utf8'
    )).includes('registry.yarnpkg.com')
  );
  // Test with default registry
  await exec(`rm -rf ${__dirname}/tmp/lockfile-registry-resolution`);
  await exec(
    `cp -r ${__dirname}/fixtures/lockfile-registry-resolution/ ${__dirname}/tmp/lockfile-registry-resolution`
  );
  await exec(`rm ${__dirname}/tmp/lockfile-registry-resolution/.yarnrc`);
  await install({
    root: `${__dirname}/tmp/lockfile-registry-resolution`,
    cwd: `${__dirname}/tmp/lockfile-registry-resolution/a`,
  });
  assert(
    (await read(
      `${__dirname}/tmp/lockfile-registry-resolution/b/yarn.lock`,
      'utf8'
    )).includes('registry.npmjs.org')
  );
  assert(
    (await read(
      `${__dirname}/tmp/lockfile-registry-resolution/c/yarn.lock`,
      'utf8'
    )).includes('registry.npmjs.org')
  );
}

async function testLockfileRegistryResolutionMultirepo() {
  await exec(
    `cp -r ${__dirname}/fixtures/lockfile-registry-resolution-multirepo/ ${__dirname}/tmp/lockfile-registry-resolution-multirepo`
  );
  await install({
    root: `${__dirname}/tmp/lockfile-registry-resolution-multirepo`,
    cwd: `${__dirname}/tmp/lockfile-registry-resolution-multirepo/first/a`,
  });
  // Expect that even though multiple projects are pinned to the same dependency version,
  // install will honor the existance of any registry overrides and write those preferences
  // back to the individual lock files
  assert(
    (await read(
      `${__dirname}/tmp/lockfile-registry-resolution-multirepo/first/a/yarn.lock`,
      'utf8'
    )).includes('registry.yarnpkg.com')
  );
  assert(
    (await read(
      `${__dirname}/tmp/lockfile-registry-resolution-multirepo/second/b/yarn.lock`,
      'utf8'
    )).includes('registry.npmjs.org')
  );
  assert(
    (await read(
      `${__dirname}/tmp/lockfile-registry-resolution-multirepo/second/b/yarn.lock`,
      'utf8'
    )).includes('registry.npmjs.org')
  );
}
