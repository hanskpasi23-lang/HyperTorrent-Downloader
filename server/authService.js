import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export class AuthService {
  constructor(options = {}) {
    this.configFile = options.configFile || path.resolve(process.cwd(), 'security-config.json');
    this.config = {
      isConfigured: false,
      authEnabled: true,
      requireLocalAuth: true,
      passwordHash: null,
      passwordSalt: null,
      apiKey: null,
      jwtSecret: null,
      googleAuth: {
        enabled: false,
        clientId: '',
        clientSecret: '',
        callbackUrl: ''
      },
      adminEmails: [],
      allowedEmails: [],
      allowedDomains: [],
      defaultUserQuota: {
        maxActiveTorrents: 3,
        maxStorageBytes: 21474836480, // 20 GB
        maxTorrentSizeBytes: 10737418240 // 10 GB
      }
    };

    this.loadConfig();
  }

  reloadConfigIfNeeded() {
    try {
      if (fs.existsSync(this.configFile)) {
        const stats = fs.statSync(this.configFile);
        if (!this._lastConfigMtime || stats.mtimeMs > this._lastConfigMtime) {
          this._lastConfigMtime = stats.mtimeMs;
          this.loadConfig();
        }
      }
    } catch (e) {}
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const parsed = JSON.parse(raw);
        // Deep-merge googleAuth and defaultUserQuota nested objects
        const mergedGoogleAuth = { ...this.config.googleAuth, ...(parsed.googleAuth || {}) };
        const mergedQuota = { ...this.config.defaultUserQuota, ...(parsed.defaultUserQuota || {}) };
        this.config = { ...this.config, ...parsed, googleAuth: mergedGoogleAuth, defaultUserQuota: mergedQuota };
      }
    } catch (err) {
      console.warn('[AuthService] Could not parse security-config.json:', err.message);
    }

    // Auto-generate jwtSecret if not present
    if (!this.config.jwtSecret) {
      this.config.jwtSecret = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
    }

    // Auto-generate apiKey if not present
    if (!this.config.apiKey) {
      this.config.apiKey = process.env.API_KEY || `ht_sec_${crypto.randomBytes(24).toString('hex')}`;
    }

    // Environment overrides for Google OAuth
    this.config.googleAuth = this.config.googleAuth || {};
    if (process.env.GOOGLE_CLIENT_ID) {
      this.config.googleAuth.clientId = process.env.GOOGLE_CLIENT_ID;
      this.config.googleAuth.enabled = true;
    }
    if (process.env.GOOGLE_CLIENT_SECRET) {
      this.config.googleAuth.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    }
    if (process.env.GOOGLE_CALLBACK_URL) {
      this.config.googleAuth.callbackUrl = process.env.GOOGLE_CALLBACK_URL;
    }

    // Admin & Allowed Emails / Domains from ENV
    if (process.env.ADMIN_EMAILS) {
      this.config.adminEmails = process.env.ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    if (process.env.ALLOWED_EMAILS) {
      this.config.allowedEmails = process.env.ALLOWED_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    if (process.env.ALLOWED_DOMAINS) {
      this.config.allowedDomains = process.env.ALLOWED_DOMAINS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }

    // Check Master Password environment overrides
    if (process.env.ADMIN_PASSWORD) {
      this.setPassword(process.env.ADMIN_PASSWORD, false);
      this.config.isConfigured = true;
    }

    if (process.env.AUTH_ENABLED !== undefined) {
      this.config.authEnabled = process.env.AUTH_ENABLED === 'true' || process.env.AUTH_ENABLED === '1';
    }

    this.saveConfig();
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.error('[AuthService] Failed to save security-config.json:', err.message);
    }
  }

  hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  setPassword(newPassword, save = true) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = this.hashPassword(newPassword, salt);
    this.config.passwordSalt = salt;
    this.config.passwordHash = hash;
    this.config.isConfigured = true;
    if (save) this.saveConfig();
  }

  verifyPassword(candidatePassword) {
    if (!this.config.isConfigured || !this.config.passwordHash || !this.config.passwordSalt) {
      return false;
    }
    try {
      const candidateHash = this.hashPassword(candidatePassword, this.config.passwordSalt);
      const a = Buffer.from(candidateHash, 'hex');
      const b = Buffer.from(this.config.passwordHash, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) {
      return false;
    }
  }

  verifyApiKey(candidateApiKey) {
    if (!this.config.apiKey || !candidateApiKey) return false;
    try {
      const a = Buffer.from(candidateApiKey);
      const b = Buffer.from(this.config.apiKey);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) {
      return false;
    }
  }

  /**
   * Create JWT token for admin or specific user
   */
  createToken(userOrPayload = null, expiresInHours = 168) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const exp = now + (expiresInHours * 3600);

    let payloadObj = {
      sub: 'admin',
      role: 'admin',
      email: 'admin@local',
      name: 'Master Admin',
      iat: now,
      exp: exp
    };

    if (userOrPayload) {
      payloadObj = {
        sub: userOrPayload.id || userOrPayload.sub || 'admin',
        role: userOrPayload.role || 'user',
        email: userOrPayload.email || 'user@local',
        name: userOrPayload.name || 'User',
        picture: userOrPayload.picture || null,
        iat: now,
        exp: exp
      };
    }

    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');

    const signature = crypto
      .createHmac('sha256', this.config.jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    return `${header}.${payload}.${signature}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'Missing token' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'Malformed token' };
    }

    const [header, payload, signature] = parts;
    const expectedSignature = crypto
      .createHmac('sha256', this.config.jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url');

    try {
      const a = Buffer.from(signature);
      const b = Buffer.from(expectedSignature);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { valid: false, reason: 'Invalid signature' };
      }

      const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const now = Math.floor(Date.now() / 1000);

      if (decodedPayload.exp && decodedPayload.exp < now) {
        return { valid: false, reason: 'Token expired' };
      }

      return { valid: true, payload: decodedPayload };
    } catch (err) {
      return { valid: false, reason: 'Invalid token payload' };
    }
  }

  regenerateApiKey() {
    this.config.apiKey = `ht_sec_${crypto.randomBytes(24).toString('hex')}`;
    this.saveConfig();
    return this.config.apiKey;
  }

  // ------------------------------------------------------------------------
  // Google OAuth 2.0 Helpers
  // ------------------------------------------------------------------------

  isGoogleAuthEnabled() {
    this.reloadConfigIfNeeded();
    return Boolean(
      this.config.googleAuth &&
      this.config.googleAuth.enabled &&
      this.config.googleAuth.clientId &&
      this.config.googleAuth.clientSecret
    );
  }

  getGoogleCallbackUrl(req) {
    this.reloadConfigIfNeeded();
    if (this.config.googleAuth?.callbackUrl) {
      return this.config.googleAuth.callbackUrl;
    }
    const host = req.get('host') || 'localhost:3000';
    const proto = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    return `${proto}://${host}/api/auth/google/callback`;
  }

  getGoogleAuthUrl(req, state) {
    this.reloadConfigIfNeeded();
    if (!this.isGoogleAuthEnabled()) {
      throw new Error('Google OAuth 2.0 is not enabled or credentials are not configured.');
    }
    const redirectUri = this.getGoogleCallbackUrl(req);
    const clientId = this.config.googleAuth.clientId;
    const scope = encodeURIComponent('openid email profile');
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}&prompt=select_account`;
  }

  async exchangeGoogleCode(code, redirectUri) {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams({
      code,
      client_id: this.config.googleAuth.clientId,
      client_secret: this.config.googleAuth.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Google token exchange failed: ${errText}`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      throw new Error('No access_token returned by Google');
    }

    const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!userinfoRes.ok) {
      throw new Error('Failed to fetch user profile from Google');
    }

    const profile = await userinfoRes.json();
    return {
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture
    };
  }

  getPublicStatus(isLocal = false) {
    return {
      authEnabled: this.config.authEnabled,
      isConfigured: this.config.isConfigured,
      requireLocalAuth: this.config.requireLocalAuth,
      googleAuthEnabled: this.isGoogleAuthEnabled(),
      isLocal
    };
  }

  isProtected(isLocal = false) {
    if (!this.config.authEnabled) return false;
    if (isLocal && !this.config.requireLocalAuth) return false;
    return true;
  }
}

export default new AuthService();
