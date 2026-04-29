const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const JS7z = require('js7z-tools');

suite('7z Extension Tests', () => {
  let tmpDir;

  suiteSetup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode7ztest_'));
  });

  suiteTeardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('JS7z loads successfully', async () => {
    const js7z = await JS7z();
    assert.ok(js7z, 'JS7z instance should exist');
    assert.ok(typeof js7z.callMain === 'function', 'callMain should be a function');
    assert.ok(js7z.FS, 'FS should exist');
  });

  test('Compress a single file to 7z format', async () => {
    const testFile = path.join(tmpDir, 'hello.txt');
    const archiveFile = path.join(tmpDir, 'test.7z');
    const extractDir = path.join(tmpDir, 'extracted');

    fs.writeFileSync(testFile, 'Hello, VSCode Extension!');

    const js7z = await JS7z();

    const data = fs.readFileSync(testFile);
    js7z.FS.writeFile('/hello.txt', new Uint8Array(data));

    await new Promise((resolve, reject) => {
      js7z.onExit = (exitCode) => {
        if (exitCode === 0) {
          try {
            const archiveData = js7z.FS.readFile('/test.7z', { encoding: 'binary' });
            fs.writeFileSync(archiveFile, Buffer.from(archiveData));
            assert.ok(fs.existsSync(archiveFile), 'Archive file should exist');
            assert.ok(fs.statSync(archiveFile).size > 0, 'Archive should not be empty');
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`7z exited with code ${exitCode}`));
        }
      };
      js7z.callMain(['a', '/test.7z', '/hello.txt']);
    });

    fs.mkdirSync(extractDir, { recursive: true });

    const js7z_2 = await JS7z();
    const archiveData = fs.readFileSync(archiveFile);
    js7z_2.FS.writeFile('/test.7z', new Uint8Array(archiveData));
    js7z_2.FS.mkdir('/out');

    await new Promise((resolve, reject) => {
      js7z_2.onExit = (exitCode) => {
        if (exitCode === 0) {
          try {
            const files = js7z_2.FS.readdir('/out');
            assert.ok(files.includes('hello.txt'), 'Extracted files should include hello.txt');
            const extractedData = js7z_2.FS.readFile('/out/hello.txt', { encoding: 'binary' });
            const text = Buffer.from(extractedData).toString('utf8');
            assert.strictEqual(text, 'Hello, VSCode Extension!', 'Content should match original');
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`7z exited with code ${exitCode}`));
        }
      };
      js7z_2.callMain(['x', '/test.7z', '-o/out']);
    });
  });

  test('Compress a single file to ZIP format', async () => {
    const testFile = path.join(tmpDir, 'hello2.txt');
    const archiveFile = path.join(tmpDir, 'test.zip');
    const extractDir = path.join(tmpDir, 'extracted_zip');

    fs.writeFileSync(testFile, 'Hello ZIP!');

    const js7z = await JS7z();
    const data = fs.readFileSync(testFile);
    js7z.FS.writeFile('/hello2.txt', new Uint8Array(data));

    await new Promise((resolve, reject) => {
      js7z.onExit = (exitCode) => {
        if (exitCode === 0) {
          try {
            const archiveData = js7z.FS.readFile('/test.zip', { encoding: 'binary' });
            fs.writeFileSync(archiveFile, Buffer.from(archiveData));
            assert.ok(fs.existsSync(archiveFile), 'ZIP archive should exist');
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`7z exited with code ${exitCode}`));
        }
      };
      js7z.callMain(['a', '/test.zip', '/hello2.txt']);
    });

    fs.mkdirSync(extractDir, { recursive: true });

    const js7z_2 = await JS7z();
    const archiveData = fs.readFileSync(archiveFile);
    js7z_2.FS.writeFile('/test.zip', new Uint8Array(archiveData));
    js7z_2.FS.mkdir('/out');

    await new Promise((resolve, reject) => {
      js7z_2.onExit = (exitCode) => {
        if (exitCode === 0) {
          try {
            const extractedData = js7z_2.FS.readFile('/out/hello2.txt', { encoding: 'binary' });
            const text = Buffer.from(extractedData).toString('utf8');
            assert.strictEqual(text, 'Hello ZIP!', 'Content should match');
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`7z exited with code ${exitCode}`));
        }
      };
      js7z_2.callMain(['x', '/test.zip', '-o/out']);
    });
  });

  test('Compress and decompress TAR format', async () => {
    const testFile = path.join(tmpDir, 'hello3.txt');
    const archiveFile = path.join(tmpDir, 'test.tar');

    fs.writeFileSync(testFile, 'Hello TAR!');

    const js7z = await JS7z();
    const data = fs.readFileSync(testFile);
    js7z.FS.writeFile('/hello3.txt', new Uint8Array(data));

    await new Promise((resolve, reject) => {
      js7z.onExit = (exitCode) => {
        if (exitCode === 0) {
          try {
            const archiveData = js7z.FS.readFile('/test.tar', { encoding: 'binary' });
            fs.writeFileSync(archiveFile, Buffer.from(archiveData));
            assert.ok(fs.statSync(archiveFile).size > 0, 'TAR should not be empty');
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`7z exited with code ${exitCode}`));
        }
      };
      js7z.callMain(['a', '/test.tar', '/hello3.txt']);
    });

    const js7z_2 = await JS7z();
    const archiveData = fs.readFileSync(archiveFile);
    js7z_2.FS.writeFile('/test.tar', new Uint8Array(archiveData));
    js7z_2.FS.mkdir('/out');

    await new Promise((resolve, reject) => {
      js7z_2.onExit = (exitCode) => {
        if (exitCode === 0) {
          try {
            const extractedData = js7z_2.FS.readFile('/out/hello3.txt', { encoding: 'binary' });
            const text = Buffer.from(extractedData).toString('utf8');
            assert.strictEqual(text, 'Hello TAR!', 'TAR content should match');
            resolve();
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`7z exited with code ${exitCode}`));
        }
      };
      js7z_2.callMain(['x', '/test.tar', '-o/out']);
    });
  });
});
