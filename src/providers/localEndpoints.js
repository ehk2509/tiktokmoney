// In local AI mode, only loopback, private LAN and container hostnames are allowed.
// This prevents accidentally sending prompts or frames to a hosted AI endpoint.
export function assertLocalEndpoint(value, label = 'local endpoint') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(label + ' must be a valid http(s) URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const parts = host.split('.').map(Number);
  const isIpv4 = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  const privateV4 = isIpv4 && (
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] === 192 && parts[1] === 168 ||
    parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
  );
  const privateHost = host === 'localhost' || host === '::1' ||
    host.endsWith('.localhost') || host.endsWith('.local') ||
    (!host.includes('.') && /^[a-z][a-z0-9-]*$/.test(host));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !(privateV4 || privateHost)) {
    throw new Error(label + ' must point to a local/private host (not a cloud service): ' + value);
  }
  return url.toString().replace(/\/$/, '');
}

export function localAiEnabled(env = process.env) {
  return String(env.AI_RUNTIME || '').toLowerCase() === 'local';
}
