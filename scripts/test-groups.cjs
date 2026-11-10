'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawnSync} = require('node:child_process');
const {groups, requirements, nodeTests, serverBuildGroups, rules, fullGate, documentation} = require('./test-groups.config.cjs');

const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, 'build/groups');
const GRAPH = path.join(CACHE, 'dependencies.json');
const ROOT_GROUPS = Object.keys(groups).filter((name) => name !== 'server');
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const available = (name) => !requirements[name] || fs.existsSync(path.join(ROOT, requirements[name].requires));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function fingerprint(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(file).update('\0');
    hash.update(fs.existsSync(file) ? fs.readFileSync(file) : '<missing>');
  }
  return hash.update(process.version).digest('hex');
}

function walk(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function inventory() {
  const expected = ROOT_GROUPS.filter(available).flatMap((name) => groups[name]);
  const privateTests = new Set(ROOT_GROUPS.filter((name) => !available(name)).flatMap((name) => groups[name]));
  const actual = fs.readdirSync(path.join(ROOT, 'test')).filter((file) => file.endsWith('.mocha.js'))
      .map((file) => file.slice(0, -9)).filter((name) => !privateTests.has(name));
  if (new Set(expected).size !== expected.length ||
      JSON.stringify([...expected].sort()) !== JSON.stringify(actual.sort())) {
    throw new Error('Test inventory changed: assign every test/*.mocha.js to exactly one group.');
  }
  const privateRoot = path.join(ROOT, 'eval') + path.sep;
  const imports = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const name of ROOT_GROUPS.filter((name) => !requirements[name])) {
    for (const test of groups[name]) {
      const file = path.join(ROOT, 'test', `${test}.mocha.js`);
      for (const match of fs.readFileSync(file, 'utf8').matchAll(imports)) {
        if (path.resolve(path.dirname(file), match[1]).startsWith(privateRoot)) {
          throw new Error(`Private eval import in public test ${test}: ${match[1]}`);
        }
      }
    }
  }
}

function parseArgs(args) {
  const options = {selection: [], files: [], list: false, mocha: {}};
  while (args.length) {
    const arg = args.shift();
    if (arg === '--list') options.list = true;
    else if (arg === '--files') {
      if (!args.length || args[0].startsWith('--')) throw new Error('--files requires paths.');
      while (args.length && !args[0].startsWith('--')) options.files.push(normalize(args.shift()));
    } else if (['--grep', '--reporter', '--timeout'].includes(arg)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options.mocha[arg.slice(2)] = value;
    } else if (arg === '--bail') options.mocha.bail = true;
    else if (Object.hasOwn(groups, arg) || ['all', 'changed'].includes(arg)) options.selection.push(arg);
    else throw new Error(`Unknown argument: ${arg}. Groups: ${Object.keys(groups).join(', ')}.`);
  }
  if (!options.selection.length) options.selection.push('all');
  if (options.selection.some((name) => ['all', 'changed'].includes(name)) && options.selection.length !== 1) {
    throw new Error('Use all or changed alone, or name one or more groups.');
  }
  if (options.files.length && options.selection[0] !== 'changed') throw new Error('--files is for changed only.');
  return options;
}

function normalize(file) {
  const result = relative(path.resolve(ROOT, file));
  if (!result || result.startsWith('../')) throw new Error(`Path is outside the repository: ${file}`);
  return result;
}

function gitPaths() {
  return [...new Set([
    ['diff', '--name-only', '-z', '--no-renames'],
    ['diff', '--cached', '--name-only', '-z', '--no-renames'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ].flatMap((args) => execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).split('\0').filter(Boolean)))];
}

function graphKey() {
  const head = fs.existsSync(path.join(ROOT, '.git')) ?
    execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim() : 'export';
  return head + fingerprint([
    __filename, path.join(__dirname, 'test-groups.config.cjs'),
    path.join(ROOT, 'package.json'), path.join(ROOT, 'package-lock.json'),
    require.resolve('@blockly/dev-scripts/config/webpack.config.js'),
    path.join(ROOT, 'test/.mocharc.js'),
  ]);
}

function changedGroups(files) {
  const graph = readJson(GRAPH);
  const complete = graph?.key === graphKey() && ROOT_GROUPS.filter(available).every((name) =>
    groups[name].every((test) => Array.isArray(graph.tests?.[test])));
  const reasons = {};
  const add = (names, reason) => names.forEach((name) => {
    reasons[name] ??= new Set();
    reasons[name].add(reason);
  });
  for (const file of files) {
    if (documentation.test(file)) continue;
    const testGroup = ROOT_GROUPS.find((name) => groups[name].some((test) => file === `test/${test}.mocha.js`));
    if (testGroup || file.startsWith('server/test/')) {
      add([testGroup || 'server'], file);
      continue;
    }
    if (fullGate.test(file) || !complete) {
      add(Object.keys(groups), `${file} (${fullGate.test(file) ? 'shared configuration' : 'dependency map missing or stale'})`);
      continue;
    }
    let matched = false;
    for (const [pattern, names] of rules) {
      if (pattern.test(file)) { add(names, file); matched = true; }
    }
    if (file.startsWith('server/')) add(serverBuildGroups(graph.tests), `${file} (server/dist consumers)`);
    for (const name of ROOT_GROUPS.filter(available)) {
      if (groups[name].some((test) => graph.tests[test].includes(file))) {
        add([name], `${file} (imported)`);
        matched = true;
      }
    }
    if (!matched) add(Object.keys(groups), `${file} (unmapped path)`);
  }
  return reasons;
}

function runNpm(args) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args,
      {cwd: ROOT, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.signal || result.status}).`);
}

function runNodeTests(files) {
  // The native pilot tests import server/dist outside webpack's module loader.
  ensureServer('import');
  const result = spawnSync(process.execPath, ['--test', ...files], {cwd: ROOT, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Node tests failed (${result.signal || result.status}).`);
}

function ensureServer(mode) {
  const sources = walk(path.join(ROOT, 'server/src')).filter((file) => /\.[jt]s$/.test(file));
  const key = fingerprint([...sources, ...['tsconfig.json', 'package.json', 'package-lock.json']
      .map((file) => path.join(ROOT, 'server', file)), require.resolve('typescript/package.json', {paths: [path.join(ROOT, 'server')]})]);
  const stamp = path.join(CACHE, 'server-build.json');
  const outputsExist = sources.every((file) => fs.existsSync(file.replace('/src/', '/dist/').replace(/\.ts$/, '.js')));
  if (mode !== 'all' && readJson(stamp)?.key === key && outputsExist) {
    console.log('Server build: skipped (server/dist is current).');
    return;
  }
  fs.rmSync(stamp, {force: true});
  runNpm(['--prefix', 'server', 'run', 'build']);
  writeJson(stamp, {key});
}

function externalPilot({context, request}, callback) {
  // Only this Node utility stays native. Its live-browser helpers are lazy;
  // a missing dependency still fails normally if a test actually calls one.
  if (request?.startsWith('.')) {
    const file = path.resolve(context, request);
    if (file === path.join(ROOT, 'eval/voice-pilot/compare.cjs')) {
      return callback(null, `commonjs ${file}`);
    }
  }
  callback();
}

async function compile(tests, mode) {
  const webpack = require('webpack');
  const config = require('@blockly/dev-scripts/config/webpack.config.js')({mode: 'test'});
  const names = ROOT_GROUPS.filter((name) => groups[name].some((test) => tests.includes(test)));
  const directory = path.join(CACHE, names.length === ROOT_GROUPS.length ? 'all' : names.join('+'));
  config.entry = Object.fromEntries(tests.map((name) => [name, `./test/${name}.mocha.js`]));
  config.output = {...config.output, path: directory};
  config.externals = [externalPilot];
  let serverChecked = mode === 'all';
  let serverBuildError;
  if (serverChecked) ensureServer('all');
  const checkServerImport = (file) => {
    if (!serverChecked && file && relative(file.split('?')[0]).startsWith('server/dist/')) {
      // Build before webpack loads any generated server module, including a
      // newly added import that the cached dependency graph does not know yet.
      serverChecked = true;
      try {
        ensureServer('import');
      } catch (error) {
        serverBuildError = error;
        throw error;
      }
    }
  };
  config.plugins.push({
    apply(compiler) {
      compiler.hooks.normalModuleFactory.tap('ServerBuild', (factory) => {
        factory.hooks.beforeResolve.tap('ServerBuild', (data) => {
          if (data) checkServerImport(path.resolve(data.context, data.request));
        });
        factory.hooks.afterResolve.tap('ServerBuild', (data) => {
          if (data) checkServerImport(data.createData.resource);
        });
      });
    },
  });
  const compiler = webpack(config);
  try {
    const stats = await new Promise((resolve, reject) => compiler.run((error, result) => error ? reject(error) : resolve(result)));
    // Optional imports can turn a resolver error into a webpack warning.
    if (serverBuildError) throw serverBuildError;
    console.log(stats.toString({all: false, timings: true, errors: true, warnings: true, colors: process.stdout.isTTY}));
    if (stats.hasErrors()) throw new Error('Webpack compilation failed; no tests were run.');
    if (!serverChecked) console.log('Server build: skipped (selected tests use no server/dist).');
    saveDependencies(stats.compilation);
    return tests.map((name) => path.join(directory, `${name}.mocha.js`));
  } finally {
    await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
  }
}

function saveDependencies(compilation) {
  const key = graphKey();
  const previous = readJson(GRAPH);
  const graph = previous?.key === key ? previous : {key, tests: {}};
  const addModule = (module, files) => {
    if (module.resource && !module.resource.includes(`${path.sep}node_modules${path.sep}`)) {
      const file = relative(module.resource.split('?')[0]);
      files.add(file);
      if (file.startsWith('server/dist/')) {
        const source = file.replace('server/dist/', 'server/src/');
        files.add(fs.existsSync(path.join(ROOT, source.replace(/\.js$/, '.ts'))) ? source.replace(/\.js$/, '.ts') : source);
      }
    }
    if (module.modules) for (const child of module.modules) addModule(child, files);
  };
  for (const [test, entry] of compilation.entrypoints) {
    const files = new Set();
    const chunks = new Set(entry.chunks.flatMap((chunk) => [...chunk.getAllReferencedChunks()]));
    for (const chunk of chunks) {
      for (const module of compilation.chunkGraph.getChunkModulesIterable(chunk)) addModule(module, files);
    }
    graph.tests[test] = [...files].sort();
  }
  writeJson(GRAPH, graph);
}

async function main(args) {
  process.chdir(ROOT);
  inventory();
  const options = parseArgs(args);
  const reasons = options.selection[0] === 'changed' ? changedGroups(options.files.length ? options.files : gitPaths()) :
    Object.fromEntries((options.selection[0] === 'all' ? ROOT_GROUPS : options.selection).map((name) => [name, new Set(['requested'])]));
  const skipped = Object.keys(groups).filter((name) => reasons[name] && !available(name));
  for (const name of skipped) console.log(requirements[name].message);
  const selected = Object.keys(groups).filter((name) => reasons[name] && available(name));
  const tests = selected.flatMap((name) => groups[name]).sort();
  for (const name of selected) console.log(`${name}: ${[...reasons[name]].join('; ')}`);
  if (!selected.length && !skipped.length) console.log('No tests selected (no changed executable paths).');
  if (options.list || !selected.length) return;
  if (tests.length) {
    const files = await compile(tests, options.selection[0]);
    const Mocha = require('mocha');
    const configFile = path.join(ROOT, 'test/.mocharc.js');
    const mocha = new Mocha({ui: 'tdd', ...(fs.existsSync(configFile) ? require(configFile) : {}), ...options.mocha});
    files.forEach((file) => mocha.addFile(file));
    const failures = await new Promise((resolve) => mocha.run(resolve));
    if (failures) process.exitCode = 1;
  }
  const nativeTests = [...new Set(selected.flatMap((name) => nodeTests[name] ?? []))];
  if (nativeTests.length) runNodeTests(nativeTests);
  if (selected.includes('server')) runNpm(['--prefix', 'server', 'test']);
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = {main, parseArgs, changedGroups, inventory, externalPilot};
