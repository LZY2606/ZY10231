// Minimal Mocha runner that avoids the Mocha CLI.
// Mocha 10.x's CLI loads `yargs/yargs`, which crashes on newer V8/Node
// runtimes that load the extensionless entry as an ES module.
// Driving Mocha programmatically keeps the existing dev dependencies and
// supported Node range while working on both old and new Node versions.
require("ts-node/register");
const Mocha = require("mocha");
const fs = require("fs");
const path = require("path");

const testDir = path.resolve(__dirname, "..", "test");
const mocha = new Mocha({ timeout: 10000 });
fs.readdirSync(testDir)
  .filter((file) => file.endsWith(".ts"))
  .sort()
  .forEach((file) => mocha.addFile(path.join(testDir, file)));

mocha.run((failures) => {
  process.exitCode = failures ? 1 : 0;
});
