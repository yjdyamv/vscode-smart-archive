const { buildTree, markNoisyDirs } = require('./out/providers/treeBuilder');

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('  PASS: ' + name); }
  catch (e) { failed++; console.error('  FAIL: ' + name + '\n        ' + e.message); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// Helper: create tar-like entries (all REGULAR_FILE) and build tree
function makeTree(entries, patterns) {
  const tree = buildTree(entries, 'test.tar');
  if (patterns) markNoisyDirs(tree, patterns);
  return tree;
}

// Collect all dir paths and their collapsed status
function collectDirs(nodes, result = []) {
  for (const n of nodes) {
    if (n.kind === 'DIRECTORY') {
      result.push({ name: n.name, path: n.path, collapsed: !!n.collapsed });
    }
    if (n.children) collectDirs(n.children, result);
  }
  return result;
}

console.log('\n=== Noisy Dir Tests ===\n');

test('exact name match: node_modules', () => {
  const t = makeTree([
    { path: 'src/node_modules/pkg/index.js', size: 100, type: 'REGULAR_FILE' },
  ], ['node_modules']);
  const dirs = collectDirs(t);
  const nm = dirs.find(d => d.name === 'node_modules');
  assert(nm && nm.collapsed, 'node_modules should be collapsed');
});

test('**/pattern matches at any depth', () => {
  const t = makeTree([
    { path: 'a/b/node_modules/pkg/index.js', size: 100, type: 'REGULAR_FILE' },
  ], ['**/node_modules']);
  const dirs = collectDirs(t);
  const nm = dirs.find(d => d.name === 'node_modules');
  assert(nm && nm.collapsed, '**/node_modules should match at depth');
});

test('*/pattern matches one level deep', () => {
  const t = makeTree([
    { path: 'a/.venv/pkg.py', size: 100, type: 'REGULAR_FILE' },
  ], ['*/.venv']);
  const dirs = collectDirs(t);
  const venv = dirs.find(d => d.name === '.venv');
  assert(venv && venv.collapsed, '*/.venv should match');
});

test('multiple patterns', () => {
  const t = makeTree([
    { path: 'node_modules/a.js', size: 1, type: 'REGULAR_FILE' },
    { path: 'dist/b.js', size: 1, type: 'REGULAR_FILE' },
    { path: 'src/c.js', size: 1, type: 'REGULAR_FILE' },
  ], ['node_modules', 'dist']);
  const dirs = collectDirs(t);
  assert(dirs.find(d => d.name === 'node_modules')?.collapsed, 'node_modules collapsed');
  assert(dirs.find(d => d.name === 'dist')?.collapsed, 'dist collapsed');
  assert(!dirs.find(d => d.name === 'src')?.collapsed, 'src not collapsed');
});

test('no matches → nothing collapsed', () => {
  const t = makeTree([
    { path: 'src/a.js', size: 1, type: 'REGULAR_FILE' },
    { path: 'lib/b.js', size: 1, type: 'REGULAR_FILE' },
  ], ['node_modules']);
  const dirs = collectDirs(t);
  assert(!dirs.some(d => d.collapsed), 'no dirs should be collapsed');
});

test('empty patterns → nothing collapsed', () => {
  const t = makeTree([
    { path: 'node_modules/a.js', size: 1, type: 'REGULAR_FILE' },
  ], []);
  const dirs = collectDirs(t);
  assert(!dirs.some(d => d.collapsed), 'empty patterns - nothing collapsed');
});

test('.git prefix works with dot:true', () => {
  const t = makeTree([
    { path: '.git/HEAD', size: 100, type: 'REGULAR_FILE' },
  ], ['.git']);
  const dirs = collectDirs(t);
  assert(dirs.find(d => d.name === '.git')?.collapsed, '.git should be collapsed');
});

test('no duplicate nodes in buildTree for tar-like entries', () => {
  const t = makeTree([
    { path: 'a', size: 0, type: 'REGULAR_FILE' },
    { path: 'a/b', size: 0, type: 'REGULAR_FILE' },
    { path: 'a/b/file1.txt', size: 100, type: 'REGULAR_FILE' },
    { path: 'a/c', size: 0, type: 'REGULAR_FILE' },
    { path: 'a/c/file2.txt', size: 200, type: 'REGULAR_FILE' },
  ]);
  const dirs = collectDirs(t);
  // Should have exactly: a(1), b(1), c(1) = 3 dirs, no duplicates
  const names = dirs.map(d => d.name);
  assert(names.filter(n => n === 'a').length === 1, 'only one "a" dir');
  assert(names.filter(n => n === 'b').length === 1, 'only one "b" dir');
  assert(names.filter(n => n === 'c').length === 1, 'only one "c" dir');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
