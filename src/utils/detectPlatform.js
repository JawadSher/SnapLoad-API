// Detects a likely video platform name from a URL hostname.
function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');

    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'youtube';
    if (hostname.includes('tiktok.com')) return 'tiktok';
    if (hostname.includes('instagram.com')) return 'instagram';
    if (hostname.includes('facebook.com') || hostname.includes('fb.watch')) return 'facebook';
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) return 'twitter';
    if (hostname.includes('reddit.com')) return 'reddit';
    if (hostname.includes('vimeo.com')) return 'vimeo';
    if (hostname.includes('dailymotion.com')) return 'dailymotion';
    if (hostname.includes('soundcloud.com')) return 'soundcloud';
    if (hostname.includes('twitch.tv')) return 'twitch';
    if (hostname.includes('pinterest.com')) return 'pinterest';

    return 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

module.exports = {
  detectPlatform
};
