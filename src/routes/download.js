// Streams original video page downloads through yt-dlp without writing media to disk.
const { execFile, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const express = require('express');

const router = express.Router();

const RENDER_YTDLP_PATH = '/opt/render/project/src/yt-dlp';
const SYSTEM_YTDLP_PATH = 'yt-dlp';

let ffmpegAvailable;

const YT_DLP_METADATA_TIMEOUT_MS = Number(process.env.YT_DLP_METADATA_TIMEOUT_MS) || 30000;
const CONTENT_LENGTH_HEAD_TIMEOUT_MS = Number(process.env.CONTENT_LENGTH_HEAD_TIMEOUT_MS) || 8000;

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

function getFormatSelector(audioOnly) {
  return audioOnly ? 'bestaudio' : 'bestvideo+bestaudio/best';
}

function buildYtDlpArgs(url, audioOnly) {
  const args = [
    url,
    '--output',
    '-',
    '--format',
    getFormatSelector(audioOnly),
    '--no-warnings',
    '--no-check-certificate'
  ];

  if (isYouTubeUrl(url)) {
    args.push('--extractor-args', 'youtube:player_client=web');
  }

  return args;
}

function buildYtDlpMetadataArgs(url, audioOnly) {
  const args = [
    url,
    '--dump-single-json',
    '--skip-download',
    '--format',
    getFormatSelector(audioOnly),
    '--no-warnings',
    '--no-check-certificate'
  ];

  if (isYouTubeUrl(url)) {
    args.push('--extractor-args', 'youtube:player_client=web');
  }

  return args;
}

function getExactByteSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

function getExactFormatSize(format) {
  if (!format || typeof format !== 'object') {
    return null;
  }

  return getExactByteSize(format.filesize || format.contentLength);
}

function getSelectedFormats(info) {
  if (Array.isArray(info.requested_downloads) && info.requested_downloads.length > 0) {
    return info.requested_downloads;
  }

  if (Array.isArray(info.requested_formats) && info.requested_formats.length > 0) {
    return info.requested_formats;
  }

  return [info];
}

function getFetchHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => typeof value === 'string' && value.trim())
  );
}

async function getHeadContentLength(format) {
  if (!format || !format.url) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTENT_LENGTH_HEAD_TIMEOUT_MS);

  try {
    const response = await fetch(format.url, {
      method: 'HEAD',
      headers: getFetchHeaders(format.http_headers),
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    return getExactByteSize(response.headers.get('content-length'));
  } catch (error) {
    console.error('Content-Length HEAD preflight failed:', error.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getExactContentLengthFromInfo(info, convertsWithFfmpeg) {
  if (convertsWithFfmpeg || !info || typeof info !== 'object') {
    return null;
  }

  const selectedFormats = getSelectedFormats(info);

  if (selectedFormats.length !== 1) {
    return null;
  }

  return getExactFormatSize(selectedFormats[0]) || getHeadContentLength(selectedFormats[0]);
}

function getYtDlpMetadata(ytdlpPath, url, audioOnly) {
  return new Promise((resolve) => {
    execFile(ytdlpPath, buildYtDlpMetadataArgs(url, audioOnly), {
      timeout: YT_DLP_METADATA_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout) => {
      if (error) {
        console.error('yt-dlp metadata preflight failed:', error.message);
        resolve(null);
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        console.error('yt-dlp metadata preflight returned invalid JSON:', parseError.message);
        resolve(null);
      }
    });
  });
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

router.get('/', async (req, res) => {
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

  let responseFinished = false;
  let clientDisconnected = false;
  let ytdlpProcess = null;
  let ffmpegProcess = null;

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

  const ytdlpPath = resolveYtDlpPath();
  const convertsWithFfmpeg = wantsMp3 && hasFfmpeg();
  const metadata = await getYtDlpMetadata(ytdlpPath, url, audioOnly);
  const contentLength = await getExactContentLengthFromInfo(metadata, convertsWithFfmpeg);

  if (clientDisconnected) {
    return undefined;
  }

  ytdlpProcess = spawn(ytdlpPath, buildYtDlpArgs(url, audioOnly), {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stderrChunks = [];

  res.status(200);
  res.setHeader('Content-Type', audioOnly ? 'audio/mpeg' : 'video/mp4');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${audioOnly ? 'snapload-audio.mp3' : 'snapload-video.mp4'}"`
  );
  res.setHeader('Cache-Control', 'no-cache');

  if (contentLength) {
    res.setHeader('Content-Length', String(contentLength));
  } else {
    res.setHeader('Transfer-Encoding', 'chunked');
  }

  ytdlpProcess.stderr.on('data', (chunk) => {
    stderrChunks.push(chunk);
  });

  ytdlpProcess.on('error', (error) => {
    endWithDownloadError(res, `Download failed: ${error.message}`);
  });

  if (convertsWithFfmpeg) {
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
