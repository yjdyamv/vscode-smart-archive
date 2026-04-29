const path = require('path');
const { glob } = require('glob');

exports.run = function () {
  const testsRoot = path.resolve(__dirname);
  glob.sync('**/**.test.js', { cwd: testsRoot }).forEach((f) => {
    require(path.resolve(testsRoot, f));
  });
};
