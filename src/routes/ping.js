// Provides a lightweight health check endpoint for uptime monitors and Render wake checks.
const express = require('express');

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    res.json({
      success: true,
      status: 'awake',
      message: 'SnapLoad API is ready',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
