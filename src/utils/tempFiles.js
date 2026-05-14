const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const TEMP_DIR = '/tmp';
const SNAPLOAD_PREFIX = 'snapload-';
const MAX_FILE_AGE_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

function isSafeFileId(fileId) {
  return /^snapload-[A-Za-z0-9-]+$/.test(String(fileId || ''));
}

function getOutputTemplate(fileId) {
  return path.join(TEMP_DIR, `${fileId}.%(ext)s`);
}

async function findTempFile(fileId) {
  if (!isSafeFileId(fileId)) {
    return null;
  }

  let entries;

  try {
    entries = await fsPromises.readdir(TEMP_DIR);
  } catch (error) {
    return null;
  }

  const filename = entries.find((entry) => entry.startsWith(`${fileId}.`));
  return filename ? path.join(TEMP_DIR, filename) : null;
}

async function deleteTempFile(filePath) {
  if (!filePath || path.dirname(filePath) !== TEMP_DIR) {
    return false;
  }

  try {
    await fsPromises.unlink(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

async function deleteTempFileById(fileId) {
  const filePath = await findTempFile(fileId);

  if (!filePath) {
    return false;
  }

  return deleteTempFile(filePath);
}

async function cleanupOldTempFiles() {
  let entries;

  try {
    entries = await fsPromises.readdir(TEMP_DIR);
  } catch (error) {
    console.error('Could not scan temp files:', error.message);
    return;
  }

  const now = Date.now();

  await Promise.all(entries
    .filter((entry) => entry.startsWith(SNAPLOAD_PREFIX))
    .map(async (entry) => {
      const filePath = path.join(TEMP_DIR, entry);

      try {
        const stats = await fsPromises.stat(filePath);

        if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
          await fsPromises.unlink(filePath);
        }
      } catch (error) {
        console.error('Could not clean temp file:', error.message);
      }
    }));
}

function startTempFileCleanup() {
  cleanupOldTempFiles();

  const interval = setInterval(cleanupOldTempFiles, CLEANUP_INTERVAL_MS);

  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

function formatFileSize(bytes) {
  const size = Number(bytes);

  if (!Number.isFinite(size) || size <= 0) {
    return '0 MB';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.mp3') {
    return 'audio/mpeg';
  }

  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
    return 'video/mp4';
  }

  return 'application/octet-stream';
}

module.exports = {
  TEMP_DIR,
  findTempFile,
  deleteTempFile,
  deleteTempFileById,
  formatFileSize,
  getContentType,
  getOutputTemplate,
  startTempFileCleanup
};
