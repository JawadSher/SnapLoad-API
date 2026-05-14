// Make sure YTDLP_BINARY env variable is set on Render dashboard to: /opt/render/project/src/yt-dlp
// Runs yt-dlp and normalizes extractor metadata into the SnapLoad API response shape.
const { execFile } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { promisify } = require('util');

const { formatDuration } = require('../utils/formatDuration');
const { formatSize } = require('../utils/formatSize');
const { detectPlatform } = require('../utils/detectPlatform');

const execFileAsync = promisify(execFile);
const RENDER_YTDLP_PATH = '/opt/render/project/src/yt-dlp';
const SYSTEM_YTDLP_PATH = 'yt-dlp';
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS) || 30000;
const YOUTUBE_COOKIES_PATH = '/tmp/yt-cookies.txt';
const YOUTUBE_PLAYER_CLIENTS = ['web', 'mweb', 'android', 'ios'];

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

const YTDLP_PATH = resolveYtDlpPath();

if (fs.existsSync(YTDLP_PATH)) {
  console.log('yt-dlp binary found at:', YTDLP_PATH);
} else {
  console.error('yt-dlp binary NOT found at:', YTDLP_PATH);
}

const INVIDIOUS_INSTANCES = [
  'https://invidious.io.lol',
  'https://invidious.fdn.fr',
  'https://invidious.perennialte.ch',
  'https://iv.melmac.space',
  'https://invidious.reallyaweso.me',
  'https://invidious.darkness.services'
];

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

function extractYouTubeVideoId(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace(/^www\./, '').replace(/^m\./, '');

    if (hostname === 'youtu.be') {
      return parsedUrl.pathname.split('/').filter(Boolean)[0] || null;
    }

    if (!hostname.endsWith('youtube.com')) {
      return null;
    }

    if (parsedUrl.pathname === '/watch') {
      return parsedUrl.searchParams.get('v');
    }

    const match = parsedUrl.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
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

function getFormatExtension(format) {
  if (format.container) {
    return String(format.container).split(',')[0].trim();
  }

  if (format.type) {
    const mimeType = String(format.type).split(';')[0];
    const extension = mimeType.split('/')[1];
    return extension || 'mp4';
  }

  return 'mp4';
}

function buildInvidiousFormats(info) {
  const sourceFormats = [
    ...(Array.isArray(info.formatStreams) ? info.formatStreams : []),
    ...(Array.isArray(info.adaptiveFormats) ? info.adaptiveFormats : [])
  ];
  const byQuality = new Map();

  sourceFormats
    .filter((format) => format && format.url)
    .filter((format) => String(format.type || '').includes('video/mp4'))
    .filter((format) => format.qualityLabel)
    .forEach((format) => {
      const quality = String(format.qualityLabel);

      if (!byQuality.has(quality)) {
        const ext = getFormatExtension(format);

        byQuality.set(quality, {
          quality,
          format: ext,
          url: format.url,
          fileSize: formatSize(format.contentLength),
          isAudio: false,
          label: `${quality} ${ext.toUpperCase()}`
        });
      }
    });

  const bestAudio = sourceFormats
    .filter((format) => format && format.url)
    .filter((format) => String(format.type || '').includes('audio'))
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0];

  const formats = Array.from(byQuality.values());

  if (bestAudio) {
    const ext = getFormatExtension(bestAudio);
    const quality = bestAudio.qualityLabel || bestAudio.quality || 'audio';

    formats.push({
      quality: 'audio',
      format: ext,
      url: bestAudio.url,
      fileSize: formatSize(bestAudio.contentLength),
      isAudio: true,
      label: `${quality} ${ext.toUpperCase()}`
    });
  }

  formats.sort((a, b) => {
    if (a.isAudio) {
      return 1;
    }

    if (b.isAudio) {
      return -1;
    }

    return qualityRank(b.quality) - qualityRank(a.quality);
  });

  return formats;
}

async function fetchInvidiousJson(instance, videoId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${instance}/api/v1/videos/${videoId}`, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Invidious returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function runInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const info = await fetchInvidiousJson(instance, videoId);
      const thumbnails = Array.isArray(info.videoThumbnails) ? info.videoThumbnails : [];
      const thumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '';
      const formats = buildInvidiousFormats(info);

      if (formats.length === 0) {
        throw new Error('Invidious returned no usable formats');
      }

      console.log(`Invidious layer succeeded with ${instance}`);

      return {
        success: true,
        platform: 'youtube',
        title: info.title || 'Untitled video',
        thumbnail,
        duration: formatDuration(info.lengthSeconds),
        uploader: info.author || '',
        formats
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Invidious instance failed (${instance}): ${message}`);
    }
  }

  return null;
}

function mapYtDlpError(error) {
  const message = String(error && (error.stderr || error.stdout || error.message || error)).toLowerCase();

  if (message.includes('enoent') || message.includes('not found')) {
    return `yt-dlp binary was not found at ${YTDLP_PATH}`;
  }

  if (message.includes('sign in') || message.includes('not a bot') || message.includes('cookies')) {
    return 'YouTube blocked this server request. Add exported YouTube cookies to the YOUTUBE_COOKIES environment variable on Render.';
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

function buildYtDlpArgs(url, playerClient) {
  const args = [
    url,
    '--dump-single-json',
    '--no-warnings',
    '--no-check-certificate',
    '--prefer-free-formats',
    '--extractor-args',
    `youtube:player_client=${playerClient}`,
    '--extractor-args',
    'youtube:player_skip=webpage',
    '--add-header',
    'referer:youtube.com',
    '--add-header',
    'user-agent:Mozilla/5.0'
  ];

  return args;
}

async function addCookiesArgs(args) {
  if (process.env.YOUTUBE_COOKIES) {
    await fsPromises.writeFile(YOUTUBE_COOKIES_PATH, process.env.YOUTUBE_COOKIES, 'utf8');
    args.push('--cookies', YOUTUBE_COOKIES_PATH);
  }
}

async function runYtDlpWithArgs(args) {
  const { stdout } = await execFileAsync(YTDLP_PATH, args, {
    timeout: YT_DLP_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024
  });

  return JSON.parse(stdout);
}

async function runYtDlp(url, isYouTube = false) {
  const playerClients = isYouTube ? YOUTUBE_PLAYER_CLIENTS : ['web'];
  let lastError;

  for (const playerClient of playerClients) {
    const args = buildYtDlpArgs(url, playerClient);
    await addCookiesArgs(args);

    try {
      const info = await runYtDlpWithArgs(args);
      console.log(`yt-dlp layer succeeded with player_client=${playerClient}`);
      return info;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`yt-dlp failed with player_client=${playerClient}: ${message}`);
    }
  }

  throw lastError;
}

async function extractVideoInfo(url, options = {}) {
  try {
    const videoId = extractYouTubeVideoId(url);

    if (videoId) {
      const invidiousResult = await runInvidious(videoId);

      if (invidiousResult) {
        return invidiousResult;
      }

      console.log('Invidious layer failed, falling back to yt-dlp layer');
    }

    const info = await runYtDlp(url, Boolean(videoId));
    console.log(videoId ? 'yt-dlp YouTube fallback layer succeeded' : 'yt-dlp layer succeeded');

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
