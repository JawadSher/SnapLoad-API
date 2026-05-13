// Runs yt-dlp and normalizes extractor metadata into the SnapLoad API response shape.
const { execFile } = require('child_process');
const { promisify } = require('util');

const { formatDuration } = require('../utils/formatDuration');
const { formatSize } = require('../utils/formatSize');
const { detectPlatform } = require('../utils/detectPlatform');

const execFileAsync = promisify(execFile);
const YT_DLP_BINARY = process.env.YT_DLP_PATH || 'yt-dlp';
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS) || 30000;

const QUALITY_LABELS = new Map([
  [2160, '4K'],
  [1440, '1440p'],
  [1080, '1080p'],
  [720, '720p'],
  [480, '480p'],
  [360, '360p'],
  [240, '240p'],
  [144, '144p']
]);

function getQualityLabel(height) {
  if (!height) {
    return 'best';
  }

  return QUALITY_LABELS.get(Number(height)) || `${height}p`;
}

function qualityRank(quality) {
  if (quality === '4K') {
    return 2160;
  }

  if (quality === 'audio') {
    return -1;
  }

  const parsed = Number(String(quality).replace('p', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildVideoFormats(formats) {
  const byQuality = new Map();

  formats
    .filter((format) => format && format.url)
    .filter((format) => format.vcodec && format.vcodec !== 'none')
    .filter((format) => format.acodec && format.acodec !== 'none')
    .filter((format) => format.height)
    .forEach((format) => {
      const quality = getQualityLabel(format.height);

      if (!byQuality.has(quality)) {
        const ext = format.ext || 'mp4';

        byQuality.set(quality, {
          quality,
          format: ext,
          url: format.url,
          fileSize: formatSize(format.filesize || format.filesize_approx),
          isAudio: false,
          label: `${quality} ${ext.toUpperCase()}`
        });
      }
    });

  return Array.from(byQuality.values());
}

function buildAudioFormat(formats) {
  const bestAudio = formats
    .filter((format) => format && format.url)
    .filter((format) => format.vcodec === 'none' && format.acodec && format.acodec !== 'none')
    .sort((a, b) => (Number(b.abr) || 0) - (Number(a.abr) || 0))[0];

  if (!bestAudio) {
    return null;
  }

  return {
    quality: 'audio',
    format: 'mp3',
    url: bestAudio.url,
    fileSize: formatSize(bestAudio.filesize || bestAudio.filesize_approx),
    isAudio: true,
    label: 'Audio Only (MP3)'
  };
}

function buildFallbackFormat(info) {
  if (!info || !info.url) {
    return null;
  }

  const ext = info.ext || 'mp4';

  return {
    quality: 'best',
    format: ext,
    url: info.url,
    fileSize: formatSize(info.filesize || info.filesize_approx),
    isAudio: false,
    label: `Best ${ext.toUpperCase()}`
  };
}

function mapYtDlpError(error) {
  const message = String(error && (error.stderr || error.stdout || error.message || error)).toLowerCase();

  if (message.includes('enoent') || message.includes('not found')) {
    return 'yt-dlp is not installed on the server';
  }

  if (message.includes('sign in')) {
    return 'This video requires login';
  }

  if (message.includes('unavailable')) {
    return 'This video is unavailable or private';
  }

  if (message.includes('not supported')) {
    return 'This platform is not supported yet';
  }

  if (message.includes('private video')) {
    return 'This is a private video';
  }

  if (message.includes('age')) {
    return 'This video has age restrictions';
  }

  return 'Could not extract video. Try again.';
}

async function runYtDlp(url) {
  const args = [
    url,
    '--dump-single-json',
    '--no-warnings',
    '--no-call-home',
    '--no-check-certificate',
    '--prefer-free-formats',
    '--youtube-skip-dash-manifest',
    '--add-header',
    'referer:youtube.com',
    '--add-header',
    'user-agent:Mozilla/5.0'
  ];

  const { stdout } = await execFileAsync(YT_DLP_BINARY, args, {
    timeout: YT_DLP_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024
  });

  return JSON.parse(stdout);
}

async function extractVideoInfo(url, options = {}) {
  try {
    const info = await runYtDlp(url);

    const rawFormats = Array.isArray(info.formats) ? info.formats : [];
    const videoFormats = buildVideoFormats(rawFormats);
    const audioFormat = buildAudioFormat(rawFormats);
    const formats = [...videoFormats];

    if (audioFormat) {
      formats.push(audioFormat);
    }

    if (formats.length === 0) {
      const fallback = buildFallbackFormat(info);

      if (fallback) {
        formats.push(fallback);
      }
    }

    formats.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));

    return {
      success: true,
      platform: info.extractor_key ? String(info.extractor_key).toLowerCase() : detectPlatform(url),
      title: info.title || 'Untitled video',
      thumbnail: info.thumbnail || '',
      duration: formatDuration(info.duration),
      uploader: info.uploader || info.channel || '',
      formats
    };
  } catch (err) {
    console.error(err);

    return {
      success: false,
      error: mapYtDlpError(err),
      formats: []
    };
  }
}

module.exports = {
  extractVideoInfo
};
