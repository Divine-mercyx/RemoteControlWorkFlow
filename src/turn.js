import crypto from 'node:crypto';

/**
 * ICE servers for RTCPeerConnection. TURN credentials follow coturn's
 * "use-auth-secret" scheme: username = "<expiry>:<id>", credential = HMAC-SHA1(secret, username).
 */
export function iceServers(config, id = 'nolt') {
  const servers = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  if (config.turnUrls.length && config.turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSeconds;
    const username = `${expiry}:${id}`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    servers.push({ urls: config.turnUrls, username, credential });
  }
  return servers;
}
