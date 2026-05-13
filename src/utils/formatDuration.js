// Converts raw duration seconds into a compact MM:SS or H:MM:SS display string.
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) {
    return '0:00';
  }

  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const paddedSeconds = String(remainingSeconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }

  return `${minutes}:${paddedSeconds}`;
}

module.exports = {
  formatDuration
};
