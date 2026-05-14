// Serves and deletes completed SnapLoad temp downloads.
const fs = require('fs');
const path = require('path');
const express = require('express');

const {
  deleteTempFile,
  deleteTempFileById,
  findTempFile,
  getContentType
} = require('../utils/tempFiles');

const router = express.Router();

function getDownloadFilename(filePath) {
  return path.extname(filePath).toLowerCase() === '.mp3' ? 'snapload.mp3' : 'snapload.mp4';
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
