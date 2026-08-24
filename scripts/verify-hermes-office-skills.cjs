'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'vendor', 'hermes-agent', 'skills', 'productivity');
const runtimePython = process.platform === 'win32'
  ? path.join(root, 'runtime', 'hermes', 'python', 'python.exe')
  : path.join(root, 'runtime', 'hermes', 'python', 'bin', 'python3');
const required = ['docx', 'xlsx', 'powerpoint'];
const skills = required.map((name) => {
  const file = path.join(source, name, 'SKILL.md');
  return { name, file, present: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 };
});
let modules = null;
let pythonError = null;
try {
  const output = execFileSync(runtimePython, ['-c', 'import importlib.util,json; print(json.dumps({"docx":bool(importlib.util.find_spec("docx")),"openpyxl":bool(importlib.util.find_spec("openpyxl")),"pptx":bool(importlib.util.find_spec("pptx"))}))'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  modules = JSON.parse(output);
} catch (error) {
  pythonError = String(error && error.message || error);
}
const libreOffice = process.env.PATH.split(path.delimiter).some((entry) => fs.existsSync(path.join(entry, process.platform === 'win32' ? 'soffice.exe' : 'soffice')));
const result = {
  generatedAt: new Date().toISOString(),
  skills,
  runtimePython,
  pythonModules: modules,
  pythonError,
  libreOffice,
  result: skills.every((item) => item.present) && modules && Object.values(modules).every(Boolean) ? 'READY_WITHOUT_LIBREOFFICE' : 'BLOCKED'
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.result === 'BLOCKED') process.exitCode = 2;
