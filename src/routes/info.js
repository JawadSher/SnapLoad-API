// Handles GET metadata lookups using a URL query parameter and default extraction options.
const express = require('express');

const { extractVideoInfo } = require('../services/ytdlp');
const { isValidUrl } = require('../utils/validateUrl');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { url } = req.query;

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

    const result = await extractVideoInfo(url, {});

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
