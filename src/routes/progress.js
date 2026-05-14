// Runs a temp-file yt-dlp download and streams progress events over SSE.
const { spawn } = require('child_process');
const fs = require('fs');
const express = require('express');

const {
  deleteTempFileById,
  findTempFile,
  formatFileSize,
  getOutputTemplate
} = require('../utils/tempFiles');

const router = express.Router();

const RENDER_YTDLP_PATH = '/opt/render/project/src/yt-dlp';
const SYSTEM_YTDLP_PATH = 'yt-dlp';
const YOUTUBE_EXTRACTOR_ARGS = 'youtube:player_client=default,ios,android,web';

function resolveYtDlpPath() {
  if (process.env.YTDLP_BINARY) {
    if (fs.existsSync(process.env.YTDLP_BINARY)) {
      return process.env.YTDLP_BINARY;
    }

    console.error('YTDLP_BINARY path does not exist, falling back:', process.env.YTDLP_BINARY);
  }

  if (fs.existsSync(RENDER_YTDLP_PATH)) {
    return RENDER_YTDLP_PATH;
  }

  return SYSTEM_YTDLP_PATH;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function isValidHttpUrl(value) {
  try {
    const parsedUrl = new URL(value);
    return ['http:', 'https:'].includes(parsedUrl.protocol);
  } catch (error) {
    return false;
  }
}

function isYouTubeUrl(value) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, '').replace(/^m\./, '');
    return hostname === 'youtu.be' || hostname.endsWith('youtube.com');
  } catch (error) {
    return false;
  }
}

function createFileId() {
  return `snapload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildYtDlpArgs(url, fileId, audioOnly) {
  const args = [
    url,
    '--output',
    getOutputTemplate(fileId),
    '--no-warnings',
    '--no-check-certificate',
    '--progress',
    '--newline'
  ];

  if (isYouTubeUrl(url)) {
    args.push('--extractor-args', YOUTUBE_EXTRACTOR_ARGS);
  }

  if (audioOnly) {
    args.push('--extract-audio', '--audio-format', 'mp3');
  } else {
    args.push('--format', 'bestvideo+bestaudio/best');
  }

  return args;
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeSizeText(value) {
  const match = String(value || '').match(/^([\d.]+)\s*([KMGT]?i?B)(\/s)?$/i);

  if (!match) {
    return String(value || '');
  }

  const unit = match[2]
    .replace(/KiB/i, 'KB')
    .replace(/MiB/i, 'MB')
    .replace(/GiB/i, 'GB')
    .replace(/TiB/i, 'TB');

  return `${match[1]} ${unit}${match[3] || ''}`;
}

function parseProgressLine(line) {
  const match = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\w+)/);

  if (!match) {
    return null;
  }

  const speedMatch = line.match(/\sat\s+([^\s]+)/);
  const etaMatch = line.match(/\sETA\s+([^\s]+)/);

  return {
    type: 'progress',
    percentage: Number(match[1]),
    totalSize: normalizeSizeText(match[2]),
    speed: speedMatch ? normalizeSizeText(speedMatch[1]) : '',
    eta: etaMatch ? etaMatch[1] : ''
  };
}

function handleProgressChunk(chunk, state, onLine) {
  state.buffer += chunk.toString('utf8');

  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() || '';
  lines.forEach(onLine);
}

router.get('/', (req, res) => {
  const { url } = req.query;
  const audioOnly = isTruthy(req.query.audioOnly) || String(req.query.format || '').toLowerCase() === 'mp3';

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'url is required',
      type: 'validation_error'
    });
  }

  if (!isValidHttpUrl(url)) {
    return res.status(400).json({
      success: false,
      error: 'Please provide a valid HTTP or HTTPS video page URL',
      type: 'validation_error'
    });
  }

  const fileId = createFileId();
  const ytdlpProcess = spawn(resolveYtDlpPath(), buildYtDlpArgs(url, fileId, audioOnly), {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const progressState = { buffer: '' };
  const stderrChunks = [];
  let completed = false;
  let clientDisconnected = false;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sendSse(res, {
    type: 'start',
    message: 'Starting download...'
  });

  ytdlpProcess.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);

    handleProgressChunk(chunk, progressState, (line) => {
      const progress = parseProgressLine(line);

      if (progress) {
        sendSse(res, progress);
      }
    });
  });

  ytdlpProcess.on('error', (error) => {
    if (!clientDisconnected) {
      sendSse(res, {
        type: 'error',
        message: `Download failed: ${error.message}`
      });
      res.end();
    }
  });

  ytdlpProcess.on('close', async (code) => {
    if (clientDisconnected) {
      return;
    }

    if (code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.split('\n').slice(-1)[0]}` : '';

      sendSse(res, {
        type: 'error',
        message: `Download failed${detail}`
      });
      res.end();
      return;
    }

    const filePath = await findTempFile(fileId);

    if (!filePath) {
      sendSse(res, {
        type: 'error',
        message: 'Downloaded file was not found'
      });
      res.end();
      return;
    }

    const stats = await fs.promises.stat(filePath);
    completed = true;

    sendSse(res, {
      type: 'complete',
      fileId,
      filename: audioOnly ? 'snapload.mp3' : 'snapload.mp4',
      fileSize: formatFileSize(stats.size)
    });
    res.end();
  });

  res.on('close', async () => {
    if (!completed) {
      clientDisconnected = true;
      ytdlpProcess.kill('SIGTERM');
      await deleteTempFileById(fileId);
    }
  });

  return undefined;
});

module.exports = router;
