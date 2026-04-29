const path = require('path');
const { execSync } = require('child_process');

const testDir = path.resolve(__dirname, 'out');

try {
  console.log('Running core tests...');
  execSync(`node "${path.join(testDir, 'core.test.js')}"`, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });
  console.log('\nRunning preview tests...');
  execSync(`node "${path.join(testDir, 'preview.test.js')}"`, {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
  });
  console.log('\nAll tests passed.');
} catch (err) {
  console.error('Test run failed:', err.message);
  process.exit(1);
}
