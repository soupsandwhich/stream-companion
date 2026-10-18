/**
 * Rotating log file for the main process (and the local server it hosts).
 *
 * Tees console.log/info/warn/error into
 *   %APPDATA%\StreamCompanion\logs\stream-companion.log
 * rotating at 5 MB and keeping 3 old files (.1 .. .3).
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

let logFile = null;
let size = 0;

function rotate() {
  try {
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${logFile}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${logFile}.${i + 1}`);
    }
    if (fs.existsSync(logFile)) fs.renameSync(logFile, `${logFile}.1`);
  } catch (e) {
    // Another process (e.g. a second instance on its way out) may hold it; keep appending
  }
  size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
}

function write(level, args) {
  if (!logFile) return;
  const line = `${new Date().toISOString()} [${level}] ${util.format(...args)}\n`;
  try {
    if (size + line.length > MAX_BYTES) rotate();
    fs.appendFileSync(logFile, line);
    size += Buffer.byteLength(line);
  } catch (e) {
    // Never let logging take the app down
  }
}

function init(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'stream-companion.log');
    size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  } catch (e) {
    logFile = null;
    return null;
  }

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      write(level === 'log' ? 'info' : level, args);
      try { original(...args); } catch (e) { /* no console attached (packaged app) */ }
    };
  }
  return logFile;
}

module.exports = { init, getFile: () => logFile };
