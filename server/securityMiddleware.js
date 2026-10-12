import rateLimit from 'express-rate-limit';
import authService from './authService.js';
import { URL } from 'url';

/**
 * Detect if incoming request is from loopback or localhost
 */
export function isLocalRequest(req) {
  const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip === 'localhost'
  );
}

/**
 * Extract token from multiple request locations
 */
function extractCredentials(req) {
  // 1. Authorization header: "Bearer <token>" or "ApiKey <key>"
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      return { token: authHeader.substring(7).trim() };
    }
    if (authHeader.startsWith('ApiKey ')) {
      return { apiKey: authHeader.substring(7).trim() };
    }
    return { token: authHeader.trim() };
  }

  // 2. X-API-Key header
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader) {
    return { apiKey: String(apiKeyHeader).trim() };
  }

  // 3. Cookie (parsed via cookie-parser or fallback)
  if (req.cookies && req.cookies.ht_token) {
    return { token: req.cookies.ht_token };
  }
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)ht_token=([^;]+)/);
    if (match) {
      return { token: decodeURIComponent(match[1]) };
    }
  }

  // 4. Query string (essential for IDM multi-stream, <a> tags, <video src="...">, and WebSocket upgrades)
  if (req.query?.token) {
    return { token: String(req.query.token).trim() };
  }
  if (req.query?.apiKey) {
    return { apiKey: String(req.query.apiKey).trim() };
  }
  if (!req.query && req.url) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const t = parsedUrl.searchParams.get('token');
      const a = parsedUrl.searchParams.get('apiKey');
      if (t) return { token: t.trim() };
      if (a) return { apiKey: a.trim() };
    } catch (e) {}
  }

  return {};
}

/**
 * Protect API routes with Master Password token or API Key
 */
export function requireAuth(req, res, next) {
  const isLocal = isLocalRequest(req);

  // If not configured yet, let user hit setup endpoints
  if (!authService.config.isConfigured) {
    return res.status(403).json({
      error: 'Security setup required',
      setupRequired: true
    });
  }

  // If auth is disabled or local bypass is allowed
  if (!authService.isProtected(isLocal)) {
    req.user = { id: 'admin', role: 'admin', email: 'admin@local', bypass: true };
    return next();
  }

  const { token, apiKey } = extractCredentials(req);

  // Check API Key
  if (apiKey && authService.verifyApiKey(apiKey)) {
    req.user = { id: 'admin', role: 'admin', email: 'api-key@local', authType: 'api_key' };
    return next();
  }

  // Check Token
  if (token) {
    const verification = authService.verifyToken(token);
    if (verification.valid) {
      const payload = verification.payload || {};
      req.user = {
        id: payload.sub || 'admin',
        role: payload.role || 'user',
        email: payload.email || 'user@local',
        name: payload.name || 'User',
        picture: payload.picture || null,
        authType: 'jwt'
      };
      return next();
    }
  }

  return res.status(401).json({
    error: 'Unauthorized: Valid session token or API key required',
    authRequired: true
  });
}

/**
 * Require Master Admin privilege
 */
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Master Administrator privilege required.' });
  }
  next();
}

/**
 * WebSocket Handshake Authenticator & User Resolver
 */
export function getWsUser(req) {
  const isLocal = isLocalRequest(req);

  if (!authService.config.isConfigured || !authService.isProtected(isLocal)) {
    return { id: 'admin', role: 'admin', email: 'admin@local', name: 'Admin (Local Bypass)' };
  }

  const { token, apiKey } = extractCredentials(req);

  if (apiKey && authService.verifyApiKey(apiKey)) {
    return { id: 'admin', role: 'admin', email: 'api-key@local', name: 'Master Admin (API Key)' };
  }

  if (token) {
    const verification = authService.verifyToken(token);
    if (verification.valid && verification.payload) {
      const p = verification.payload;
      return {
        id: p.sub || 'user',
        role: p.role || 'user',
        email: p.email || 'user@local',
        name: p.name || 'User',
        picture: p.picture || null
      };
    }
  }

  return null;
}

export function verifyWsAuth(req) {
  const user = getWsUser(req);
  return Boolean(user);
}

/**
 * Validate external URL against SSRF (prevents scanning local networks or metadata)
 */
export function isSafeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { safe: false, reason: 'Only HTTP and HTTPS protocols are permitted' };
    }

    const host = parsed.hostname.toLowerCase();

    // Block loopback & localhost
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0'
    ) {
      return { safe: false, reason: 'Access to loopback/localhost is restricted' };
    }

    // Block AWS/Cloud Metadata & Link-Local addresses
    if (host === '169.254.169.254' || host.startsWith('169.254.')) {
      return { safe: false, reason: 'Access to cloud metadata endpoints is prohibited' };
    }

    // Block RFC 1918 Private IP Ranges
    if (
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)
    ) {
      return { safe: false, reason: 'Access to internal/private LAN addresses is prohibited' };
    }

    return { safe: true, url: parsed.toString() };
  } catch (e) {
    return { safe: false, reason: 'Malformed URL format' };
  }
}

// --------------------------------------------------------------------------
// Rate Limiters
// --------------------------------------------------------------------------

// 1. Login & Setup Limiter (Stops brute-force attacks)
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max 15 login attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' }
});

// 2. General API Limiter
export const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 180, // 180 requests per min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded: Too many requests, please slow down.' }
});

// 3. Torrent Action Limiter (Adding magnets or files)
export const torrentAddLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max 30 torrent additions per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Torrent queue rate limit reached. Please wait a moment.' }
});

// 4. Search & Sniffing Limiter
export const searchRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 40, // max 40 searches / sniffs per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Search rate limit reached. Please wait before searching again.' }
});
