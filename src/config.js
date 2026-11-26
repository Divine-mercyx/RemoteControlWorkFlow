// Central configuration, read once from environment variables.
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env = process.env) {
  const config = {
    port: num(env.PORT, 8080),
    // Public base URL used to build join links, e.g. https://support.nolt.app
    publicUrl: (env.PUBLIC_URL || `http://localhost:${num(env.PORT, 8080)}`).replace(/\/$/, ''),
    // Shared secret technicians (or the admin backend) use to create sessions.
    // Phase 3: replace with the admin backend's JWT.
    techApiKey: env.TECH_API_KEY || '',
    // How long a join link stays valid before someone clicks it.
    linkTtlMs: num(env.LINK_TTL_SECONDS, 600) * 1000,
    // Hard cap on a session's total lifetime.
    sessionMaxMs: num(env.SESSION_MAX_SECONDS, 7200) * 1000,
    // STUN/TURN. TURN uses coturn's "use-auth-secret" (time-limited credentials).
    stunUrls: (env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').filter(Boolean),
    turnUrls: (env.TURN_URLS || '').split(',').filter(Boolean),
    turnSecret: env.TURN_SECRET || '',
    turnTtlSeconds: num(env.TURN_TTL_SECONDS, 3600),
    // Comma-separated allowed origins for the Socket.IO / API (the admin frontend).
    corsOrigins: (env.CORS_ORIGINS || '').split(',').filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
  };
  if (!config.techApiKey) {
    if (env.NODE_ENV === 'production') throw new Error('TECH_API_KEY is required in production');
    config.techApiKey = 'dev-tech-key';
    console.warn('[config] TECH_API_KEY not set; using "dev-tech-key" (development only)');
  }
  return config;
}
