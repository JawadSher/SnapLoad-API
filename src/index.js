// Bootstraps the Express server, security middleware, API routes, and JSON error handling.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const pingRoute = require('./routes/ping');
const extractRoute = require('./routes/extract');
const infoRoute = require('./routes/info');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: 'Too many requests',
      type: 'rate_limit_error'
    });
  }
});

function apiKeyMiddleware(req, res, next) {
  const requiredApiKey = process.env.API_KEY;

  if (!requiredApiKey) {
    return next();
  }

  const providedApiKey = req.get('x-api-key') || req.query.apiKey;

  if (providedApiKey !== requiredApiKey) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key',
      type: 'auth_error'
    });
  }

  return next();
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    name: 'snapload-api',
    message: 'Welcome to the SnapLoad API',
    endpoints: [
      { method: 'GET', path: '/', description: 'API welcome and endpoint list' },
      { method: 'GET', path: '/ping', description: 'Health check' },
      { method: 'POST', path: '/api/extract', description: 'Extract video formats from a URL' },
      { method: 'GET', path: '/api/info?url=VIDEO_URL', description: 'Extract video metadata and default formats' }
    ]
  });
});

app.use('/ping', pingRoute);
app.use('/api', apiLimiter, apiKeyMiddleware);
app.use('/api/extract', extractRoute);
app.use('/api/info', infoRoute);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    type: 'not_found_error'
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  const statusCode = err.status || err.statusCode || 500;
  const isClientError = statusCode >= 400 && statusCode < 500;

  res.status(statusCode).json({
    success: false,
    error: isClientError && err.message ? err.message : 'Internal server error',
    type: err.type || (isClientError ? 'request_error' : 'server_error')
  });
});

app.listen(PORT, () => {
  console.log(`SnapLoad API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
