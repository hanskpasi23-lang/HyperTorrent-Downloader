import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import * as archiverPkg from 'archiver';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import TorrentManager from './torrentManager.js';
import SearchEngine from './searchEngine.js';
import authService from './authService.js';
import userManager from './userManager.js';
import {
  requireAuth,
  requireAdmin,
  verifyWsAuth,
  getWsUser,
  isLocalRequest,
  authRateLimiter,
  generalApiLimiter,
  torrentAddLimiter,
  searchRateLimiter
} from './securityMiddleware.js';

function createZipArchive(options = {}) {
  const opts = { store: true, forceZip64: true, ...options };
  if (archiverPkg.ZipArchive) {
    return new archiverPkg.ZipArchive(opts);
  }
  if (typeof archiverPkg.default === 'function') {
    return archiverPkg.default('zip', opts);
  }
  if (typeof archiverPkg === 'function') {
    return archiverPkg('zip', opts);
  }
  throw new Error('Unsupported archiver format');
}

// Global error guards to protect daemon from abrupt socket wire terminations
process.on('uncaughtException', (err) => {
  console.warn('[Daemon Safe Guard - UncaughtException]:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[Daemon Safe Guard - UnhandledRejection]:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

// Disable HTTP server timeout limits for large downloads and mobile streams
server.timeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

const wss = new WebSocketServer({ noServer: true });

// Protect WebSocket upgrade handshake with token or API key
server.on('upgrade', (request, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  } catch (e) {}

  if (pathname === '/ws') {
    if (!verifyWsAuth(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 3000;
export const manager = new TorrentManager({
  downloadDir: process.env.DOWNLOAD_DIR || path.resolve(__dirname, '../downloads')
});
export const searchEngine = new SearchEngine();

// Configure Multer for .torrent file uploads (stored in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB limit for .torrent files
});

// Middleware
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve(__dirname, '../public')));

// Apply general API rate limiter to all /api/ endpoints
app.use('/api', generalApiLimiter);

// ----------------------------------------------------
// AUTHENTICATION & SECURITY ROUTES (PUBLIC)
// ----------------------------------------------------

// Status endpoint: returns setup status and whether auth is active
app.get('/api/auth/status', (req, res) => {
  const isLocal = isLocalRequest(req);
  res.json(authService.getPublicStatus(isLocal));
});

// Onboarding: setup initial master password
app.post('/api/auth/setup', authRateLimiter, (req, res) => {
  try {
    if (authService.config.isConfigured) {
      return res.status(400).json({ error: 'System is already configured. Please log in.' });
    }
    const { password } = req.body;
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Master password must be at least 6 characters long.' });
    }

    authService.setPassword(password, true);
    const token = authService.createToken();

    res.cookie('ht_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const adminUser = {
      id: 'admin',
      role: 'admin',
      email: 'admin@local',
      name: 'Master Admin'
    };

    res.json({
      success: true,
      message: 'Master password configured successfully',
      token,
      apiKey: authService.config.apiKey,
      user: adminUser
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Master Password Login
app.post('/api/auth/login', authRateLimiter, (req, res) => {
  try {
    if (!authService.config.isConfigured) {
      return res.status(400).json({ error: 'Setup required before login', setupRequired: true });
    }

    const { password } = req.body;
    if (!password || !authService.verifyPassword(password)) {
      return res.status(401).json({ error: 'Incorrect master password' });
    }

    const token = authService.createToken();

    res.cookie('ht_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    const adminUser = {
      id: 'admin',
      role: 'admin',
      email: 'admin@local',
      name: 'Master Admin'
    };

    res.json({
      success: true,
      token,
      apiKey: authService.config.apiKey,
      user: adminUser
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google OAuth 2.0 Authentication Redirect
app.get('/api/auth/google', (req, res) => {
  try {
    if (!authService.isGoogleAuthEnabled()) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Google OAuth Setup Required</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#090e1a;color:#fff;padding:2.5rem;max-width:620px;margin:0 auto;line-height:1.6;">
          <h2 style="color:#00f2fe;">⚡ Google OAuth 2.0 Setup Required</h2>
          <p>To enable 1-Click Google Sign-In on this VPS, configure your Google Cloud credentials:</p>
          <ol style="color:#cbd5e1;padding-left:1.2rem;">
            <li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#38bdf8;">Google Cloud Console > Credentials</a>.</li>
            <li>Create an <b>OAuth 2.0 Client ID</b> (Web application).</li>
            <li>Add this Authorized Redirect URI:<br><code style="background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;display:inline-block;margin:6px 0;word-break:break-all;">${authService.getGoogleCallbackUrl(req)}</code></li>
            <li>Add your <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to your <b>.env</b> file or configure them in the Admin Security Modal.</li>
          </ol>
          <p><a href="/" style="display:inline-block;margin-top:1rem;padding:8px 16px;background:linear-gradient(135deg,#00f2fe,#4facfe);color:#000;font-weight:700;border-radius:6px;text-decoration:none;">← Return to HyperTorrent</a></p>
        </body>
        </html>
      `);
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000 // 10 minutes
    });

    const authUrl = authService.getGoogleAuthUrl(req, state);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Google OAuth initialization error: ${err.message}`);
  }
});

// Google OAuth 2.0 Callback Handler
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
    }

    if (!code) {
      return res.redirect('/?auth_error=Missing_authorization_code');
    }

    const savedState = req.cookies?.oauth_state;
    if (!state || !savedState || state !== savedState) {
      return res.redirect('/?auth_error=Invalid_OAuth_state');
    }
    res.clearCookie('oauth_state');

    const redirectUri = authService.getGoogleCallbackUrl(req);
    const profile = await authService.exchangeGoogleCode(code, redirectUri);

    const user = userManager.handleGoogleUser(profile, authService.config);
    const token = authService.createToken(user);

    res.cookie('ht_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.redirect('/?login=success');
  } catch (err) {
    console.error('[Google OAuth Callback Error]:', err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('ht_token', { path: '/' });
  res.json({ success: true, message: 'Logged out successfully' });
});

// ----------------------------------------------------
// PROTECTED API MIDDLEWARE & ADVANCED RATE LIMITS
// ----------------------------------------------------

// Guard all remaining /api/* routes with requireAuth
app.use('/api', requireAuth);

// Authenticated session check
app.get('/api/auth/me', (req, res) => {
  res.json({ authenticated: true, user: req.user });
});

// Get current API key (Admin Only)
app.get('/api/auth/api-key', requireAdmin, (req, res) => {
  res.json({ apiKey: authService.config.apiKey });
});

// Regenerate API key (Admin Only)
app.post('/api/auth/regenerate-key', requireAdmin, (req, res) => {
  const newKey = authService.regenerateApiKey();
  res.json({ success: true, apiKey: newKey });
});

// Update security settings (Admin Only)
app.put('/api/auth/settings', requireAdmin, (req, res) => {
  try {
    const { currentPassword, newPassword, requireLocalAuth, authEnabled } = req.body;

    if (newPassword) {
      if (!currentPassword || !authService.verifyPassword(currentPassword)) {
        return res.status(400).json({ error: 'Current password is required to set new password' });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters long' });
      }
      authService.setPassword(newPassword, true);
    }

    if (requireLocalAuth !== undefined) {
      authService.config.requireLocalAuth = Boolean(requireLocalAuth);
    }

    if (authEnabled !== undefined) {
      authService.config.authEnabled = Boolean(authEnabled);
    }

    authService.saveConfig();

    res.json({
      success: true,
      config: authService.getPublicStatus(isLocalRequest(req))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// MULTI-USER & RBAC ADMIN ENDPOINTS
// ----------------------------------------------------

// List all users and quota telemetry (Admin Only)
app.get('/api/users', requireAdmin, (req, res) => {
  const users = userManager.getAllUsers();
  const allTorrents = manager.getAllTorrents();

  const enriched = users.map(u => ({
    ...u,
    usage: userManager.getUserUsage(u.id, allTorrents)
  }));

  res.json({ users: enriched });
});

// Update user role (Admin Only)
app.put('/api/users/:userId/role', requireAdmin, (req, res) => {
  try {
    const { role } = req.body;
    const updated = userManager.updateUserRole(req.params.userId, role);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update user storage / concurrency quota (Admin Only)
app.put('/api/users/:userId/quota', requireAdmin, (req, res) => {
  try {
    const updated = userManager.updateUserQuota(req.params.userId, req.body);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Ban or activate user (Admin Only)
app.put('/api/users/:userId/status', requireAdmin, (req, res) => {
  try {
    const { status } = req.body;
    const updated = userManager.setUserStatus(req.params.userId, status);
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete user (Admin Only)
app.delete('/api/users/:userId', requireAdmin, (req, res) => {
  try {
    userManager.deleteUser(req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get Google OAuth & Multi-User Whitelist settings (Admin Only)
app.get('/api/auth/google-config', requireAdmin, (req, res) => {
  res.json({
    enabled: authService.config.googleAuth?.enabled || false,
    clientId: authService.config.googleAuth?.clientId || '',
    hasSecret: Boolean(authService.config.googleAuth?.clientSecret),
    callbackUrl: authService.getGoogleCallbackUrl(req),
    adminEmails: authService.config.adminEmails || [],
    allowedEmails: authService.config.allowedEmails || [],
    allowedDomains: authService.config.allowedDomains || [],
    defaultUserQuota: authService.config.defaultUserQuota || {}
  });
});

// Update Google OAuth & Multi-User Whitelist settings (Admin Only)
app.put('/api/auth/google-config', requireAdmin, (req, res) => {
  try {
    const { clientId, clientSecret, callbackUrl, enabled, adminEmails, allowedEmails, allowedDomains, defaultUserQuota } = req.body;

    authService.config.googleAuth = authService.config.googleAuth || {};

    // Only update clientId if a non-empty value is provided (prevents accidental wipe)
    if (clientId !== undefined && clientId.trim() !== '') {
      authService.config.googleAuth.clientId = clientId.trim();
    }
    // Only update clientSecret if a non-empty value is provided
    if (clientSecret !== undefined && clientSecret.trim() !== '') {
      authService.config.googleAuth.clientSecret = clientSecret.trim();
    }
    if (callbackUrl !== undefined) authService.config.googleAuth.callbackUrl = callbackUrl.trim();
    if (enabled !== undefined) authService.config.googleAuth.enabled = Boolean(enabled);

    if (adminEmails !== undefined) {
      authService.config.adminEmails = Array.isArray(adminEmails)
        ? adminEmails.map(s => String(s).trim().toLowerCase()).filter(Boolean)
        : String(adminEmails).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    if (allowedEmails !== undefined) {
      authService.config.allowedEmails = Array.isArray(allowedEmails)
        ? allowedEmails.map(s => String(s).trim().toLowerCase()).filter(Boolean)
        : String(allowedEmails).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    if (allowedDomains !== undefined) {
      authService.config.allowedDomains = Array.isArray(allowedDomains)
        ? allowedDomains.map(s => String(s).trim().toLowerCase()).filter(Boolean)
        : String(allowedDomains).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    if (defaultUserQuota) {
      authService.config.defaultUserQuota = { ...authService.config.defaultUserQuota, ...defaultUserQuota };
    }

    authService.saveConfig();

    res.json({
      success: true,
      googleAuthEnabled: authService.isGoogleAuthEnabled()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Strict rate limiters for intensive operations
app.use('/api/torrents/magnet', torrentAddLimiter);
app.use('/api/torrents/upload', torrentAddLimiter);
app.use('/api/search', searchRateLimiter);
app.use('/api/sniff-page', searchRateLimiter);

// ----------------------------------------------------
// REST API ROUTES
// ----------------------------------------------------

// Global stats
app.get('/api/status', (req, res) => {
  res.json(manager.getGlobalStats());
});

// List torrents (filtered by user role)
app.get('/api/torrents', (req, res) => {
  res.json(manager.getAllTorrents(req.user));
});

// Get torrent details
app.get('/api/torrents/:infoHash', (req, res) => {
  const details = manager.getTorrent(req.params.infoHash);
  if (!details) {
    return res.status(404).json({ error: 'Torrent not found' });
  }
  res.json(details);
});

// Search Torrents with Seeder-based Health Filter and Auto-Add option
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    const autoAdd = req.query.autoAdd === 'true';

    if (!query) {
      return res.status(400).json({ error: 'Search query parameter `q` is required' });
    }

    const results = await searchEngine.search(query);

    let autoAddedTorrent = null;
    if (autoAdd && results.length > 0) {
      // Pick top-ranked torrent (highest seeders) and add to engine
      const best = results[0];
      autoAddedTorrent = await manager.addTorrent(best.magnetURI, { user: req.user });
    }

    res.json({
      query,
      count: results.length,
      autoAdded: !!autoAddedTorrent,
      autoAddedTorrent,
      results
    });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sniff any webpage URL for magnet links and auto-extract/filter them
app.post('/api/sniff-page', async (req, res) => {
  try {
    const { pageUrl, autoAdd } = req.body;
    if (!pageUrl) {
      return res.status(400).json({ error: 'pageUrl is required' });
    }

    const magnets = await searchEngine.sniffWebpage(pageUrl);

    let autoAddedTorrent = null;
    if (autoAdd && magnets.length > 0) {
      autoAddedTorrent = await manager.addTorrent(magnets[0].magnetURI, { user: req.user });
    }

    res.json({
      pageUrl,
      count: magnets.length,
      autoAdded: !!autoAddedTorrent,
      autoAddedTorrent,
      magnets
    });
  } catch (err) {
    console.error('Sniff error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add torrent via Magnet URI, URL, or InfoHash
app.post('/api/torrents/magnet', async (req, res) => {
  try {
    const raw = req.body.magnetURI || req.body.url || req.body.link || req.body.torrent || req.body.source || (typeof req.body === 'string' ? req.body : null);
    if (!raw || typeof raw !== 'string') {
      return res.status(400).json({ error: 'Valid magnet URI, .torrent URL, or infoHash string is required' });
    }

    console.log(`[API POST /api/torrents/magnet] Received link: ${raw.substring(0, 60)}...`);
    const summary = await manager.addTorrent(raw.trim(), { user: req.user });
    res.status(201).json({ success: true, torrent: summary });
  } catch (err) {
    console.error('Error adding magnet/torrent:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add torrent via .torrent file upload
app.post('/api/torrents/upload', upload.single('torrentFile'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'A .torrent file is required' });
    }

    const summary = await manager.addTorrent(req.file.buffer, { user: req.user });
    res.status(201).json({ success: true, torrent: summary });
  } catch (err) {
    console.error('Error adding .torrent file:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Pause torrent
app.post('/api/torrents/:infoHash/pause', (req, res) => {
  try {
    manager.pauseTorrent(req.params.infoHash);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Resume torrent
app.post('/api/torrents/:infoHash/resume', (req, res) => {
  try {
    manager.resumeTorrent(req.params.infoHash);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Toggle sequential downloading
app.post('/api/torrents/:infoHash/sequential', (req, res) => {
  try {
    const enable = req.body.enable;
    const isSequential = manager.toggleSequential(req.params.infoHash, enable);
    res.json({ success: true, sequential: isSequential });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ⚡ Turbo Boost single torrent
app.post('/api/torrents/:infoHash/boost', async (req, res) => {
  try {
    const result = await manager.boostTorrent(req.params.infoHash);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⚡ Turbo Boost ALL active torrents
app.post('/api/torrents/boost-all', async (req, res) => {
  try {
    const result = await manager.boostAllTorrents();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⚡ Swarm Quality & Peer Optimizer — Manual optimization trigger
app.post('/api/torrents/:infoHash/optimize', (req, res) => {
  try {
    const result = manager.optimizeTorrent(req.params.infoHash);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⚡ Swarm Quality & Peer Optimizer — Telemetry stats
app.get('/api/optimizer/stats', (req, res) => {
  res.json(manager.peerOptimizer ? manager.peerOptimizer.getStats() : { engineActive: false });
});

// Live Trackers Telemetry & Cache
app.get('/api/trackers/live', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    const trackers = await manager.trackerService.fetchLiveTrackers(force);
    res.json({
      count: trackers.length,
      lastFetched: manager.trackerService.lastFetched,
      stats: manager.trackerService.stats,
      trackers
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔒 Proxy Configuration — Get current proxy status
app.get('/api/proxy', (req, res) => {
  res.json(manager.proxyService.getStatus());
});

// 🔒 Proxy Configuration — Update proxy settings (Admin Only)
app.put('/api/proxy', requireAdmin, (req, res) => {
  try {
    const { enabled, type, host, port, username, password } = req.body;
    const status = manager.proxyService.updateConfig({
      enabled: enabled !== undefined ? enabled : manager.proxyService.config.enabled,
      type: type || manager.proxyService.config.type,
      host: host !== undefined ? host : manager.proxyService.config.host,
      port: port !== undefined ? port : manager.proxyService.config.port,
      username: username !== undefined ? username : manager.proxyService.config.username,
      password: password !== undefined ? password : manager.proxyService.config.password
    });
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔒 Proxy Configuration — Test proxy connectivity (Admin Only)
app.post('/api/proxy/test', requireAdmin, async (req, res) => {
  try {
    const result = await manager.proxyService.testConnection(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 🚦 Concurrency Queue & Memory Guard Configuration (Get Status)
app.get('/api/queue', (req, res) => {
  res.json({
    config: manager.queueConfig,
    memory: manager.memoryStats,
    stats: {
      activeCount: manager.client.torrents.filter(t => {
        const st = manager.torrentsState.get(t.infoHash) || {};
        return !st.paused && !st.queued && !t.done && (t.progress || 0) < 1;
      }).length,
      queuedCount: manager.client.torrents.filter(t => {
        const st = manager.torrentsState.get(t.infoHash) || {};
        return st.queued && !st.paused && !t.done && (t.progress || 0) < 1;
      }).length
    }
  });
});

// 🚦 Concurrency Queue & Memory Guard Configuration (Update - Admin Only)
app.put('/api/queue', requireAdmin, (req, res) => {
  try {
    const updated = manager.updateQueueConfig(req.body);
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set file selection (download or skip file)
app.post('/api/torrents/:infoHash/files/:fileIndex/priority', (req, res) => {
  try {
    const fileIndex = parseInt(req.params.fileIndex, 10);
    const selected = req.body.selected !== false;
    const result = manager.setFileSelection(req.params.infoHash, fileIndex, selected);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete torrent
app.delete('/api/torrents/:infoHash', async (req, res) => {
  try {
    const deleteFiles = req.query.deleteFiles === 'true';
    await manager.removeTorrent(req.params.infoHash, deleteFiles, req.user);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// In-Flight Media Streaming with HTTP Range Support (206 Partial Content)
app.get('/api/stream/:infoHash/:fileIndex', (req, res) => {
  try {
    const torrent = manager.findTorrent(req.params.infoHash);
    if (!torrent) {
      return res.status(404).json({ error: 'Torrent not found' });
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    let file = torrent.files && torrent.files[fileIndex];
    if (!file) {
      const diskFiles = manager.getDiskFiles(torrent.name);
      if (diskFiles && diskFiles[fileIndex]) {
        file = diskFiles[fileIndex];
      }
    }
    if (!file) {
      return res.status(404).json({ error: 'File index not found' });
    }

    // Disable socket timeouts for uninterrupted media streaming
    req.socket.setTimeout(0);
    res.setTimeout(0);
    if (req.socket.setKeepAlive) {
      req.socket.setKeepAlive(true, 10000);
    }

    // Prioritize pieces for this file
    try { file.select(); } catch (e) {}

    const total = file.length;
    const range = req.headers.range;
    const filename = file.name || `file_${fileIndex}`;

    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      '.mp4': 'video/mp4',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.m4v': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.srt': 'text/plain',
      '.vtt': 'text/vtt'
    };
    const contentType = mimeMap[ext] || file.mime || 'application/octet-stream';

    const diskPath = path.resolve(torrent.path || manager.downloadDir, file.path || file.name);
    const resolvedDownloadDir = path.resolve(manager.downloadDir);
    if (!diskPath.startsWith(resolvedDownloadDir)) {
      return res.status(403).json({ error: 'Access denied: Path traversal attempt detected' });
    }
    const isOnDisk = fs.existsSync(diskPath);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

      if (start >= total || end >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }

      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Connection': 'keep-alive'
      });

      const stream = isOnDisk
        ? fs.createReadStream(diskPath, { start, end, highWaterMark: 256 * 1024 })
        : file.createReadStream({ start, end });

      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[Stream Error]:', err.message);
      });
      req.on('close', () => {
        if (!res.writableEnded) {
          try { stream.destroy(); } catch (e) {}
        }
      });
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Connection': 'keep-alive'
      });

      const stream = isOnDisk
        ? fs.createReadStream(diskPath, { highWaterMark: 256 * 1024 })
        : file.createReadStream();

      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[Stream Error]:', err.message);
      });
      req.on('close', () => {
        if (!res.writableEnded) {
          try { stream.destroy(); } catch (e) {}
        }
      });
    }
  } catch (err) {
    console.error('Streaming exception:', err);
    res.status(500).json({ error: err.message });
  }
});

// 📦 One-Click "Download All as ZIP" (On-The-Fly High-Speed Wire Streaming)
app.get('/api/download/:infoHash/zip', async (req, res) => {
  try {
    const torrent = manager.findTorrent(req.params.infoHash);
    if (!torrent) {
      return res.status(404).json({ error: 'Torrent not found' });
    }

    let files = torrent.files && torrent.files.length > 0 ? torrent.files : null;
    if (!files || files.length === 0) {
      const diskFiles = manager.getDiskFiles(torrent.name);
      if (diskFiles && diskFiles.length > 0) {
        files = diskFiles;
      }
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'Torrent files are still being indexed from swarm' });
    }

    // Disable socket timeouts for large downloads (prevents mobile/Wi-Fi drops after 5 mins)
    req.socket.setTimeout(0);
    res.setTimeout(0);
    if (req.socket.setKeepAlive) {
      req.socket.setKeepAlive(true, 10000);
    }

    const rawName = torrent.name || torrent.displayName || 'HyperTorrent_Archive';
    const safeZipName = rawName.replace(/[\/\\?%*:|"<>]/g, '_').trim();
    const encodedName = encodeURIComponent(safeZipName).replace(/['()]/g, escape);

    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeZipName}.zip"; filename*=UTF-8''${encodedName}.zip`,
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive',
      'Keep-Alive': 'timeout=1200',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    // store: true avoids CPU-intensive zlib compression on already compressed media (mp4/mkv),
    // allowing wire-speed streaming with zero event-loop blocking.
    // forceZip64: true ensures archives over 2GB/4GB are fully supported without 32-bit integer overflow.
    const archive = createZipArchive({ store: true, forceZip64: true });

    // Abort stream if user cancels download in browser or network drops
    let isAborted = false;
    req.on('close', () => {
      if (!res.writableEnded) {
        isAborted = true;
        try { archive.abort(); } catch (e) {}
      }
    });

    archive.on('warning', (err) => {
      console.warn('[ZIP Streaming Warning]:', err.message);
    });

    archive.on('error', (err) => {
      console.error('[ZIP Streaming Error]:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    archive.pipe(res);

    for (const file of files) {
      if (isAborted) break;

      const entryName = file.path || file.name;
      const diskPath = file.diskPath || path.resolve(torrent.path || manager.downloadDir, file.path || file.name);

      if (fs.existsSync(diskPath)) {
        // Stream directly from disk - 256KB buffer for high throughput with zero RAM bloat
        const fileStream = fs.createReadStream(diskPath, { highWaterMark: 256 * 1024 });
        archive.append(fileStream, { name: entryName });
      } else if (typeof file.createReadStream === 'function') {
        // Fallback to WebTorrent swarm piece stream
        try { file.select(); } catch (e) {}
        const fileStream = file.createReadStream();
        archive.append(fileStream, { name: entryName });
      }
    }

    if (!isAborted) {
      await archive.finalize();
    }
  } catch (err) {
    console.error('ZIP download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// 🚀 Direct HTTPS File Download (Cloud Seedbox Mode to Local PC)
// Supports multi-threaded parallel chunk downloaders (IDM, aria2, Free Download Manager, Browser)
app.get('/api/download/:infoHash/:fileIndex', (req, res) => {
  try {
    const torrent = manager.findTorrent(req.params.infoHash);
    if (!torrent) {
      return res.status(404).json({ error: 'Torrent not found' });
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    let file = torrent.files && torrent.files[fileIndex];
    if (!file) {
      const diskFiles = manager.getDiskFiles(torrent.name);
      if (diskFiles && diskFiles[fileIndex]) {
        file = diskFiles[fileIndex];
      }
    }

    if (!file) {
      return res.status(404).json({ error: 'File index not found' });
    }

    // Disable socket timeouts for large mobile downloads
    req.socket.setTimeout(0);
    res.setTimeout(0);
    if (req.socket.setKeepAlive) {
      req.socket.setKeepAlive(true, 10000);
    }

    const total = file.length;
    const range = req.headers.range;
    const filename = file.name || `file_${fileIndex}`;
    const safeFilename = encodeURIComponent(filename).replace(/['()]/g, escape);

    // Precise MIME type detection for mobile media
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
      '.mp4': 'video/mp4',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.m4v': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.srt': 'text/plain',
      '.vtt': 'text/vtt',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png'
    };
    const contentType = mimeMap[ext] || file.mime || 'application/octet-stream';

    const diskPath = file.diskPath || path.resolve(torrent.path || manager.downloadDir, file.path || file.name);
    const resolvedDownloadDir = path.resolve(manager.downloadDir);
    if (!diskPath.startsWith(resolvedDownloadDir)) {
      return res.status(403).json({ error: 'Access denied: Path traversal attempt detected' });
    }
    const isOnDisk = fs.existsSync(diskPath);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

      if (start >= total || end >= total) {
        res.writeHead(416, {
          'Content-Range': `bytes */${total}`
        });
        return res.end();
      }

      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`,
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=1200',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition'
      });

      if (req.method === 'HEAD') {
        return res.end();
      }

      const stream = isOnDisk
        ? fs.createReadStream(diskPath, { start, end, highWaterMark: 256 * 1024 })
        : file.createReadStream({ start, end });

      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[Download Stream Error]:', err.message);
      });
      req.on('close', () => {
        if (!res.writableEnded) {
          try { stream.destroy(); } catch (e) {}
        }
      });
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`,
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=1200',
        'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition'
      });

      if (req.method === 'HEAD') {
        return res.end();
      }

      const stream = isOnDisk
        ? fs.createReadStream(diskPath, { highWaterMark: 256 * 1024 })
        : file.createReadStream();

      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[Download Stream Error]:', err.message);
      });
      req.on('close', () => {
        if (!res.writableEnded) {
          try { stream.destroy(); } catch (e) {}
        }
      });
    }
  } catch (err) {
    console.error('Download exception:', err);
    res.status(500).json({ error: err.message });
  }
});

// ⚡ Turbo Downloader Metadata & Capability Probe
app.get('/api/download/:infoHash/:fileIndex/meta', (req, res) => {
  try {
    const torrent = manager.findTorrent(req.params.infoHash);
    if (!torrent) {
      return res.status(404).json({ error: 'Torrent not found' });
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    let file = torrent.files && torrent.files[fileIndex];
    if (!file) {
      const diskFiles = manager.getDiskFiles(torrent.name);
      if (diskFiles && diskFiles[fileIndex]) {
        file = diskFiles[fileIndex];
      }
    }

    if (!file) {
      return res.status(404).json({ error: 'File index not found' });
    }

    const filename = file.name || `file_${fileIndex}`;
    const diskPath = file.diskPath || path.resolve(torrent.path || manager.downloadDir, file.path || file.name);
    const isOnDisk = fs.existsSync(diskPath);

    res.json({
      infoHash: req.params.infoHash,
      fileIndex,
      name: filename,
      length: file.length,
      mime: file.mime || 'application/octet-stream',
      isOnDisk,
      supportsRange: true,
      downloadUrl: `/api/download/${encodeURIComponent(req.params.infoHash)}/${fileIndex}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 💾 Live Disk Space Telemetry (Admin Only)
app.get('/api/disk', requireAdmin, async (req, res) => {
  try {
    const stats = await manager.getDiskSpace(true);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🧹 Disk Space Cleanup (Manual Trigger - Admin Only)
app.post('/api/disk/cleanup', requireAdmin, async (req, res) => {
  try {
    const { maxAgeHours, deleteFiles } = req.body;
    const result = await manager.cleanupCompleted({
      maxAgeHours: maxAgeHours !== undefined ? Number(maxAgeHours) : 0,
      deleteFiles: deleteFiles !== undefined ? Boolean(deleteFiles) : true
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ⚙️ Auto-Cleanup Settings Update (Admin Only)
app.put('/api/disk/auto-cleanup', requireAdmin, (req, res) => {
  try {
    const updated = manager.updateAutoCleanupConfig(req.body);
    res.json({ success: true, autoCleanup: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// REAL-TIME WEBSOCKET BROADCASTER (WITH USER ISOLATION)
// ----------------------------------------------------

const clientSubscriptions = new Map(); // ws -> subscribed infoHash

wss.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.user = getWsUser(request) || { id: 'guest', role: 'user' };
  clientSubscriptions.set(ws, null);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'auth' && data.token) {
        const verification = authService.verifyToken(data.token);
        if (verification.valid && verification.payload) {
          const p = verification.payload;
          ws.user = {
            id: p.sub || 'user',
            role: p.role || 'user',
            email: p.email || 'user@local',
            name: p.name || 'User',
            picture: p.picture || null
          };
        }
      } else if (data.type === 'subscribe_details') {
        const details = manager.getTorrent(data.infoHash);
        if (details) {
          // If non-admin, verify ownership before sending deep swarm details
          const isOwner = !details.ownerId || details.ownerId === ws.user.id || details.ownerEmail === ws.user.email;
          if (ws.user.role === 'admin' || isOwner) {
            clientSubscriptions.set(ws, data.infoHash);
            ws.send(JSON.stringify({ type: 'torrent_details', details }));
          }
        }
      } else if (data.type === 'unsubscribe_details') {
        clientSubscriptions.set(ws, null);
      }
    } catch (e) {
      // Ignore invalid JSON
    }
  });

  ws.on('close', () => {
    clientSubscriptions.delete(ws);
  });
});

// Periodic WebSocket heartbeat to prune dead sockets and prevent memory buffer retention
const wsHeartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      clientSubscriptions.delete(client);
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 30000);
wsHeartbeatInterval.unref();

// Periodic broadcast interval (throttled to 1000ms to preserve VPS CPU & V8 heap)
setInterval(() => {
  if (wss.clients.size === 0) return;

  const globalStats = manager.getGlobalStats();

  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      const userTorrents = manager.getAllTorrents(client.user);

      // Only include host SSD storage telemetry for administrators
      let statsToSend = globalStats;
      const isAdminClient = !client.user || client.user.role === 'admin';
      if (!isAdminClient && globalStats.disk) {
        statsToSend = { ...globalStats };
        delete statsToSend.disk;
      }

      client.send(JSON.stringify({
        type: 'tick',
        stats: statsToSend,
        torrents: userTorrents
      }));

      // Check if client is subscribed to a specific torrent's deep details
      const subscribedHash = clientSubscriptions.get(client);
      if (subscribedHash) {
        const details = manager.getTorrent(subscribedHash);
        if (details) {
          const isOwner = !details.ownerId || details.ownerId === client.user?.id || details.ownerEmail === client.user?.email;
          if (!client.user || client.user.role === 'admin' || isOwner) {
            client.send(JSON.stringify({
              type: 'torrent_details',
              details
            }));
          }
        }
      }
    }
  }
}, 1000);

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`⚡ Torrent Engine & Web Dashboard active!`);
  console.log(`🌐 Web UI: http://localhost:${PORT}`);
  console.log(`📁 Download directory: ${manager.downloadDir}`);
  console.log(`=================================================`);
});
