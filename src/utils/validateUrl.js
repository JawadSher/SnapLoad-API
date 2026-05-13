// Validates public HTTP(S) URLs while blocking localhost and private network targets.
const net = require('net');

function isPrivateIpv4(hostname) {
  if (net.isIP(hostname) !== 4) {
    return false;
  }

  const parts = hostname.split('.').map(Number);
  const [first, second] = parts;

  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    first === 0
  );
}

function isPrivateIpv6(hostname) {
  if (net.isIP(hostname) !== 6) {
    return false;
  }

  const normalized = hostname.toLowerCase();

  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized === '::'
  );
}

function isValidUrl(string) {
  try {
    if (typeof string !== 'string' || !/^https?:\/\//i.test(string)) {
      return false;
    }

    const parsed = new URL(string);
    const hostname = parsed.hostname.toLowerCase();

    if (!hostname || hostname === 'localhost') {
      return false;
    }

    if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
      return false;
    }

    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

module.exports = {
  isValidUrl
};
