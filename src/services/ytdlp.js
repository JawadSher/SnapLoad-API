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
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['m4a', 'mp3', 'webm', 'opus', 'aac']);

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

function getFileSizeBytes(format) {
  const size = Number(format.filesize || format.filesize_approx || format.contentLength);
  return Number.isFinite(size) && size > 0 ? size : null;
}

function getFormatType(format) {
  const hasVideo = format.vcodec && format.vcodec !== 'none';
  const hasAudio = format.acodec && format.acodec !== 'none';

  if (hasVideo && hasAudio) {
    return 'video+audio';
  }

  if (hasVideo) {
    return 'video';
  }

  if (hasAudio) {
    return 'audio';
  }

  return 'unknown';
}

function isStoryboardFormat(format) {
  const ext = String(format.ext || '').toLowerCase();
  const protocol = String(format.protocol || '').toLowerCase();
  const description = `${format.format || ''} ${format.format_note || ''}`.toLowerCase();

  return ext === 'mhtml' || protocol === 'mhtml' || description.includes('storyboard');
}

function isDownloadableMediaFormat(format) {
  if (!format || !format.url || isStoryboardFormat(format)) {
    return false;
  }

  const type = getFormatType(format);

  if (type === 'unknown') {
    return false;
  }

  const ext = String(format.ext || '').toLowerCase();

  if (type === 'audio') {
    return AUDIO_EXTENSIONS.has(ext);
  }

  return VIDEO_EXTENSIONS.has(ext);
}

function buildFormatLabel(format) {
  const ext = String(format.ext || 'mp4').toUpperCase();

  if (format.isAudio) {
    return `${ext} audio`;
  }

  if (format.hasVideo && !format.hasAudio) {
    return `${format.quality} ${ext} video only`;
  }

  return `${format.quality} ${ext}`;
}

function addDownloadUrls(formats, pageUrl) {
  return formats.map((format) => {
    const params = new URLSearchParams({
      url: pageUrl,
      quality: format.quality,
      format: format.isAudio ? 'mp3' : 'mp4',
      audioOnly: String(format.isAudio)
    });

    return {
      ...format,
      downloadUrl: `/api/download?${params.toString()}`
    };
  });
}

function sortMediaFormats(a, b) {
  const aRank = a.hasVideo && a.hasAudio ? 0 : a.hasVideo ? 1 : 2;
  const bRank = b.hasVideo && b.hasAudio ? 0 : b.hasVideo ? 1 : 2;

  if (aRank !== bRank) {
    return aRank - bRank;
  }

  if (aRank === 2) {
    return (Number(b.audioBitrate) || Number(b.bitrate) || 0) - (Number(a.audioBitrate) || Number(a.bitrate) || 0);
  }

  return (Number(b.height) || 0) - (Number(a.height) || 0) || (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
}

function buildMediaFormats(formats) {
  const seen = new Set();

  return formats
    .filter(isDownloadableMediaFormat)
    .map((format) => {
      const type = getFormatType(format);
      const quality = format.height ? getQualityLabel(format.height) : (format.format_note || format.quality || type);
      const ext = format.ext || 'mp4';
      const sizeBytes = getFileSizeBytes(format);

      return {
        formatId: format.format_id || '',
        quality: String(quality),
        resolution: format.resolution || (format.width && format.height ? `${format.width}x${format.height}` : ''),
        width: format.width || null,
        height: format.height || null,
        fps: format.fps || null,
        format: ext,
        ext,
        type,
        url: format.url,
        fileSize: formatSize(sizeBytes),
        fileSizeBytes: sizeBytes,
        bitrate: format.tbr || format.vbr || format.abr || null,
        videoBitrate: format.vbr || null,
        audioBitrate: format.abr || null,
        vcodec: format.vcodec || 'none',
        acodec: format.acodec || 'none',
        protocol: format.protocol || '',
        isAudio: type === 'audio',
        hasVideo: type === 'video' || type === 'video+audio',
        hasAudio: type === 'audio' || type === 'video+audio',
        label: ''
      };
    })
    .map((format) => ({
      ...format,
      label: buildFormatLabel(format)
    }))
    .filter((format) => {
      const key = `${format.quality}:${format.ext}:${format.isAudio}:${format.hasVideo}:${format.hasAudio}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .sort(sortMediaFormats);
}

function getAvailableResolutions(formats) {
  return Array.from(
    new Set(
      formats
        .filter((format) => format.hasVideo && format.height)
        .map((format) => format.quality)
    )
  ).sort((a, b) => qualityRank(b) - qualityRank(a));
}

function getEstimatedTotalSize(formats) {
  const combinedSizes = formats
    .filter((format) => format.type === 'video+audio' && format.fileSizeBytes)
    .map((format) => format.fileSizeBytes);

  if (combinedSizes.length > 0) {
    return Math.max(...combinedSizes);
  }

  const bestVideo = formats.find((format) => format.type === 'video' && format.fileSizeBytes);
  const bestAudio = formats.find((format) => format.type === 'audio' && format.fileSizeBytes);

  if (bestVideo && bestAudio) {
    return bestVideo.fileSizeBytes + bestAudio.fileSizeBytes;
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
    '--skip-download',
    '--no-warnings',
    '--no-check-certificate',
    '--ignore-no-formats-error',
    '--no-check-formats',
    '--extractor-args',
    `youtube:player_client=${playerClient};formats=missing_pot`,
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

  const info = JSON.parse(stdout);

  if (!info) {
    throw new Error('yt-dlp returned no video information');
  }

  return info;
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
    const info = await runYtDlp(url, Boolean(videoId));
    console.log(videoId ? 'yt-dlp YouTube fallback layer succeeded' : 'yt-dlp layer succeeded');

    const rawFormats = Array.isArray(info.formats) ? info.formats : [];
    const pageUrl = info.webpage_url || info.original_url || url;
    const formats = addDownloadUrls(buildMediaFormats(rawFormats), pageUrl);

    if (formats.length === 0) {
      return {
        success: false,
        error: 'No downloadable video or audio formats found',
        formats: []
      };
    }

    const estimatedTotalSizeBytes = getEstimatedTotalSize(formats);
    const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : [];

    return {
      success: true,
      platform: info.extractor_key ? String(info.extractor_key).toLowerCase() : detectPlatform(url),
      id: info.id || '',
      title: info.title || 'Untitled video',
      description: info.description || '',
      thumbnail: info.thumbnail || '',
      thumbnails,
      duration: formatDuration(info.duration),
      durationSeconds: info.duration || 0,
      uploader: info.uploader || info.channel || '',
      uploaderId: info.uploader_id || info.channel_id || '',
      channel: info.channel || info.uploader || '',
      channelId: info.channel_id || '',
      channelUrl: info.channel_url || '',
      webpageUrl: info.webpage_url || info.original_url || url,
      originalUrl: info.original_url || url,
      uploadDate: info.upload_date || '',
      releaseDate: info.release_date || '',
      viewCount: info.view_count || 0,
      likeCount: info.like_count || 0,
      commentCount: info.comment_count || 0,
      categories: Array.isArray(info.categories) ? info.categories : [],
      tags: Array.isArray(info.tags) ? info.tags : [],
      ageLimit: info.age_limit || 0,
      availability: info.availability || '',
      liveStatus: info.live_status || '',
      extractor: info.extractor || '',
      availableResolutions: getAvailableResolutions(formats),
      totalFormats: formats.length,
      videoFormats: formats.filter((format) => format.hasVideo),
      audioFormats: formats.filter((format) => format.isAudio),
      estimatedTotalSize: formatSize(estimatedTotalSizeBytes),
      estimatedTotalSizeBytes,
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
  extractVideoInfo,
  _test: {
    buildMediaFormats,
    isDownloadableMediaFormat
  }
};
