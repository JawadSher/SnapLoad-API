// Serves and deletes completed SnapLoad temp downloads.
const fs = require('fs');
const path = require('path');
const express = require('express');

const {
  deleteTempFile,
  deleteTempFileById,
  findTempFile
} = require('../utils/tempFiles');

const router = express.Router();

function getDownloadFilename(filePath) {
  const ext = path.extname(filePath).toLowerCase() || '.mp4';
  return ext === '.mp3' || ext === '.m4a' || ext === '.opus' ? `snapload-audio${ext}` : `snapload-video${ext}`;
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.opus') return 'audio/ogg';

  return 'application/octet-stream';
}

router.get('/:fileId', async (req, res, next) => {
  try {
    const filePath = await findTempFile(req.params.fileId);

    if (!filePath) {
      return res.status(404).json({
        success: false,
        error: 'File not found',
        type: 'not_found_error'
      });
    }

    const stats = await fs.promises.stat(filePath);

    res.status(200);
    res.setHeader('Content-Type', getContentType(filePath));
    res.setHeader('Content-Disposition', `attachment; filename="${getDownloadFilename(filePath)}"`);
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader('Cache-Control', 'no-cache');

    const stream = fs.createReadStream(filePath);
    let deleted = false;
    const cleanup = () => {
      if (!deleted) {
        deleted = true;
        deleteTempFile(filePath);
      }
    };

    stream.on('error', next);
    res.on('finish', cleanup);
    res.on('close', cleanup);

    return stream.pipe(res);
  } catch (error) {
    return next(error);
  }
});

router.delete('/:fileId', async (req, res, next) => {
  try {
    await deleteTempFileById(req.params.fileId);

    return res.json({
      success: true
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
