// Handles POST video extraction requests and returns yt-dlp format data as JSON.
const express = require('express');

const { extractVideoInfo } = require('../services/ytdlp');
const { isValidUrl } = require('../utils/validateUrl');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const { url, quality, audioOnly, format } = req.body || {};

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required',
        type: 'validation_error'
      });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid video URL',
        type: 'validation_error'
      });
    }

    const result = await extractVideoInfo(url, { quality, audioOnly, format });

    if (!result.success) {
      return res.status(422).json({
        ...result,
        type: 'extraction_error'
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
