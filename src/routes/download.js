// Streams original video page downloads through yt-dlp without writing media to disk.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const express = require('express');

const router = express.Router();

const RENDER_YTDLP_PATH = '/opt/render/project/src/yt-dlp';
const SYSTEM_YTDLP_PATH = 'yt-dlp';

let ffmpegAvailable;

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

function hasFfmpeg() {
  if (typeof ffmpegAvailable === 'boolean') {
    return ffmpegAvailable;
  }

  const result = spawnSync('ffmpeg', ['-version'], {
    stdio: 'ignore',
    timeout: 2000
  });

  ffmpegAvailable = !result.error && result.status === 0;
  return ffmpegAvailable;
}

function buildYtDlpArgs(url, audioOnly) {
  const args = [
    url,
    '--output',
    '-',
    '--format',
    audioOnly ? 'bestaudio' : 'bestvideo+bestaudio/best',
    '--no-warnings',
    '--no-check-certificate'
  ];

  if (isYouTubeUrl(url)) {
    args.push('--extractor-args', 'youtube:player_client=web');
  }

  return args;
}

function endWithDownloadError(res, message) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: message,
      type: 'download_error'
    });
    return;
  }

  res.end(`\n${message}`);
}

function killProcess(childProcess) {
  if (childProcess && !childProcess.killed) {
    childProcess.kill('SIGTERM');
  }
}

router.get('/', (req, res) => {
  const { url, format } = req.query;
  const audioOnly = isTruthy(req.query.audioOnly);
  const wantsMp3 = audioOnly && String(format || '').toLowerCase() === 'mp3';

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

  const ytdlpProcess = spawn(resolveYtDlpPath(), buildYtDlpArgs(url, audioOnly), {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderrChunks = [];
  let responseFinished = false;
  let clientDisconnected = false;
  let ffmpegProcess = null;

  res.status(200);
  res.setHeader('Content-Type', audioOnly ? 'audio/mpeg' : 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${audioOnly ? 'snapload-audio.mp3' : 'snapload-video.mp4'}"`
  );
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  ytdlpProcess.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
  });

  ytdlpProcess.on('error', (error) => {
    endWithDownloadError(res, `Download failed: ${error.message}`);
  });

  res.on('finish', () => {
    responseFinished = true;
  });

  res.on('close', () => {
    if (!responseFinished) {
      clientDisconnected = true;
      killProcess(ytdlpProcess);
      killProcess(ffmpegProcess);
    }
  });

  if (wantsMp3 && hasFfmpeg()) {
    ffmpegProcess = spawn('ffmpeg', [
      '-i',
      'pipe:0',
      '-vn',
      '-f',
      'mp3',
      '-codec:a',
      'libmp3lame',
      'pipe:1'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);
    ffmpegProcess.stdout.pipe(res);

    ffmpegProcess.on('error', (error) => {
      killProcess(ytdlpProcess);
      endWithDownloadError(res, `Audio conversion failed: ${error.message}`);
    });

    ffmpegProcess.on('close', (code) => {
      if (!clientDisconnected && code !== 0 && !responseFinished) {
        killProcess(ytdlpProcess);
        endWithDownloadError(res, 'Audio conversion failed');
      }
    });
  } else {
    ytdlpProcess.stdout.pipe(res);
  }

  ytdlpProcess.on('close', (code) => {
    if (clientDisconnected) {
      return;
    }

    if (code !== 0 && !responseFinished) {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = stderr ? `: ${stderr.split('\n').slice(-1)[0]}` : '';
      endWithDownloadError(res, `Download failed${detail}`);
    }
  });
});

module.exports = router;
