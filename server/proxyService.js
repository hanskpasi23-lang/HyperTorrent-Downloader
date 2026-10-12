import fs from 'fs';
import path from 'path';
import net from 'net';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

/**
 * ProxyService — Manages SOCKS5/HTTP/HTTPS proxy routing for all torrent traffic
 * to bypass ISP BitTorrent throttling and deep packet inspection (DPI).
 *
 * Supports:
 *  - SOCKS5 proxies (best for BitTorrent — handles TCP peer connections)
 *  - HTTP proxies (for tracker HTTP requests)
 *  - HTTPS proxies (for tracker HTTPS requests)
 *
 * Persists proxy configuration to disk so settings survive restarts.
 */
export class ProxyService {
  constructor(configDir = process.cwd()) {
    this.configFile = path.resolve(configDir, 'proxy-config.json');
    this.config = {
      enabled: false,
      type: 'socks5',     // 'socks5' | 'http' | 'https'
      host: '',
      port: 1080,
      username: '',        // Optional auth
      password: '',        // Optional auth
    };

    this._httpAgent = null;
    this._httpsAgent = null;

    this.loadConfig();
  }

  // ──────────────────────────────────────────────────────────────
  // Configuration Persistence
  // ──────────────────────────────────────────────────────────────

  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, 'utf8');
        const saved = JSON.parse(data);
        this.config = { ...this.config, ...saved };
        if (this.config.enabled && this.config.host) {
          this._buildAgents();
          console.log(`[ProxyService] ✅ Loaded proxy config: ${this.config.type}://${this.config.host}:${this.config.port}`);
        }
      }
    } catch (err) {
      console.warn('[ProxyService] Could not load proxy config:', err.message);
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.error('[ProxyService] Failed to save proxy config:', err.message);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Proxy Agent Builders
  // ──────────────────────────────────────────────────────────────

  /**
   * Build reusable proxy agents from the current config
   */
  _buildAgents() {
    this._httpAgent = null;
    this._httpsAgent = null;

    if (!this.config.enabled || !this.config.host) return;

    const { type, host, port, username, password } = this.config;
    const hasAuth = username && password;

    try {
      if (type === 'socks5') {
        // SOCKS5 agents work for both HTTP and HTTPS destinations
        const authPart = hasAuth ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        const socksUrl = `socks5://${authPart}${host}:${port}`;
        this._httpAgent = new SocksProxyAgent(socksUrl);
        this._httpsAgent = new SocksProxyAgent(socksUrl);
      } else if (type === 'http') {
        const authPart = hasAuth ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        const httpUrl = `http://${authPart}${host}:${port}`;
        this._httpAgent = new HttpProxyAgent(httpUrl);
        this._httpsAgent = new HttpsProxyAgent(httpUrl);
      } else if (type === 'https') {
        const authPart = hasAuth ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
        const httpsUrl = `https://${authPart}${host}:${port}`;
        this._httpAgent = new HttpsProxyAgent(httpsUrl);
        this._httpsAgent = new HttpsProxyAgent(httpsUrl);
      }

      console.log(`[ProxyService] ⚡ Proxy agents built: ${type}://${host}:${port}${hasAuth ? ' (authenticated)' : ''}`);
    } catch (err) {
      console.error('[ProxyService] Failed to build proxy agents:', err.message);
      this._httpAgent = null;
      this._httpsAgent = null;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────

  /**
   * Update proxy configuration and rebuild agents
   */
  updateConfig(newConfig) {
    this.config = {
      ...this.config,
      ...newConfig,
      port: parseInt(newConfig.port, 10) || this.config.port
    };
    this._buildAgents();
    this.saveConfig();

    if (this.config.enabled) {
      console.log(`[ProxyService] 🔄 Proxy updated: ${this.config.type}://${this.config.host}:${this.config.port}`);
    } else {
      console.log('[ProxyService] Proxy disabled — direct connections active.');
    }

    return this.getStatus();
  }

  /**
   * Get current proxy status and config (passwords masked)
   */
  getStatus() {
    return {
      enabled: this.config.enabled,
      type: this.config.type,
      host: this.config.host,
      port: this.config.port,
      hasAuth: !!(this.config.username && this.config.password),
      agentsReady: !!(this._httpAgent && this._httpsAgent),
      proxyUrl: this.config.enabled && this.config.host
        ? `${this.config.type}://${this.config.host}:${this.config.port}`
        : null
    };
  }

  /**
   * Returns fetch options with proxy agent injected (for HTTP/HTTPS requests)
   * Use this when calling fetch() for tracker lists, .torrent downloads, etc.
   */
  getFetchOptions(url) {
    if (!this.config.enabled || (!this._httpAgent && !this._httpsAgent)) {
      return {};
    }

    const isHttps = typeof url === 'string' && url.startsWith('https://');
    return {
      agent: isHttps ? this._httpsAgent : this._httpAgent
    };
  }

  /**
   * Get the HTTP agent for use with Node http/https modules
   */
  getHttpAgent() {
    if (!this.config.enabled) return undefined;
    return this._httpAgent || undefined;
  }

  /**
   * Get the HTTPS agent for use with Node https module
   */
  getHttpsAgent() {
    if (!this.config.enabled) return undefined;
    return this._httpsAgent || undefined;
  }

  /**
   * Test proxy connectivity by attempting a TCP connection and routing test
   * Accepts optional customConfig to test before saving
   * Returns { success, latencyMs, error, message }
   */
  async testConnection(targetConfig = null) {
    const configToTest = targetConfig && targetConfig.host
      ? { ...this.config, ...targetConfig, port: parseInt(targetConfig.port, 10) || 1080 }
      : this.config;

    if (!configToTest.host) {
      return { success: false, error: 'No proxy host specified' };
    }

    const { host, port, type, username, password } = configToTest;
    const startTime = Date.now();

    // Test 1: Can we reach the proxy host and port directly?
    try {
      await this._testTcpConnect(host, port, 5000);
    } catch (err) {
      return {
        success: false,
        latencyMs: Date.now() - startTime,
        error: `Cannot reach proxy at ${host}:${port} — ${err.message}`
      };
    }

    // Build temporary agent for testing if custom config was passed
    let testAgent = null;
    try {
      const hasAuth = !!(username && password);
      const authPart = hasAuth ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
      if (type === 'socks5') {
        testAgent = new SocksProxyAgent(`socks5://${authPart}${host}:${port}`);
      } else if (type === 'http') {
        testAgent = new HttpProxyAgent(`http://${authPart}${host}:${port}`);
      } else if (type === 'https') {
        testAgent = new HttpsProxyAgent(`https://${authPart}${host}:${port}`);
      }
    } catch (e) {
      // Fallback
    }

    // Test 2: Can the proxy route traffic? (Try reaching a global CDN test endpoint)
    try {
      const testUrl = 'https://1.1.1.1/cdn-cgi/trace';
      const fetchOpts = {
        method: 'GET',
        signal: AbortSignal.timeout(4000),
        agent: testAgent || this._httpsAgent || undefined
      };

      await fetch(testUrl, fetchOpts);
      const latencyMs = Date.now() - startTime;

      return {
        success: true,
        latencyMs,
        error: null,
        message: `Proxy ${type}://${host}:${port} is working (${latencyMs}ms latency)`
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;

      if (err.message.includes('ECONNREFUSED') || err.message.includes('SOCKS') || err.message.includes('proxy') || err.message.includes('Authentication')) {
        return {
          success: false,
          latencyMs,
          error: `Proxy routing failed: ${err.message}`
        };
      }

      return {
        success: true,
        latencyMs,
        error: null,
        message: `Proxy ${type}://${host}:${port} connection verified (${latencyMs}ms)`
      };
    }
  }

  /**
   * Helper: Test raw TCP connection
   */
  _testTcpConnect(host, port, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timed out'));
      });
      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  /**
   * Disable proxy and clear agents
   */
  disable() {
    this.config.enabled = false;
    this._httpAgent = null;
    this._httpsAgent = null;
    this.saveConfig();
    console.log('[ProxyService] Proxy disabled.');
    return this.getStatus();
  }
}

export default ProxyService;
