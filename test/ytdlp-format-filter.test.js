const assert = require('assert');

const { _test } = require('../src/services/ytdlp');

const formats = _test.buildMediaFormats([
  {
    format_id: 'sb0',
    ext: 'mhtml',
    protocol: 'mhtml',
    format: 'storyboard',
    url: 'https://example.com/storyboard.mhtml',
    vcodec: 'none',
    acodec: 'none'
  },
  {
    format_id: '18',
    ext: 'mp4',
    protocol: 'https',
    url: 'https://example.com/720.mp4',
    width: 1280,
    height: 720,
    fps: 30,
    vcodec: 'avc1.42001E',
    acodec: 'mp4a.40.2',
    filesize: 47448064,
    tbr: 1200
  },
  {
    format_id: '137',
    ext: 'mp4',
    protocol: 'https',
    url: 'https://example.com/1080-video.mp4',
    width: 1920,
    height: 1080,
    fps: 30,
    vcodec: 'avc1.640028',
    acodec: 'none',
    filesize_approx: 94371840,
    vbr: 2500
  },
  {
    format_id: '140',
    ext: 'm4a',
    protocol: 'https',
    url: 'https://example.com/audio.m4a',
    vcodec: 'none',
    acodec: 'mp4a.40.2',
    filesize: 7340032,
    abr: 128
  }
]);

assert.strictEqual(formats.length, 3);
assert.ok(formats.every((format) => format.url));
assert.ok(formats.every((format) => format.ext !== 'mhtml'));
assert.ok(formats.every((format) => format.protocol !== 'mhtml'));
assert.ok(formats.every((format) => format.hasVideo || format.hasAudio));
assert.deepStrictEqual(
  formats.map((format) => format.label),
  ['720p MP4', '1080p MP4 video only', 'M4A audio']
);

console.log('ytdlp format filter test passed');
