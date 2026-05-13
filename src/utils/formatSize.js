// Converts byte counts into human-readable KB, MB, or GB strings for API responses.
function formatSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === 0) {
    return 'Unknown';
  }

  const value = Number(bytes);

  if (!Number.isFinite(value) || value <= 0) {
    return 'Unknown';
  }

  const kilobyte = 1024;
  const megabyte = kilobyte * 1024;
  const gigabyte = megabyte * 1024;

  if (value < megabyte) {
    return `${(value / kilobyte).toFixed(1)} KB`;
  }

  if (value < gigabyte) {
    return `${(value / megabyte).toFixed(1)} MB`;
  }

  return `${(value / gigabyte).toFixed(2)} GB`;
}

module.exports = {
  formatSize
};
