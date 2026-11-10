// The program runner's worker, as its own bundle next to the plugin's (build.sh copies it into the test app).
const path = require('path');

module.exports = {
  target: 'webworker',
  mode: 'production',
  devtool: false,
  entry: path.resolve(__dirname, 'src/runner/worker.js'),
  output: {path: path.resolve(__dirname, 'dist'), filename: 'run_worker.js'},
  stats: 'errors-warnings',
};
