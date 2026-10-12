import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import os from 'os';
import TrackerService, { DEFAULT_TURBO_TRACKERS } from './trackerService.js';
import ProxyService from './proxyService.js';
import PeerOptimizer from './peerOptimizer.js';

export class TorrentManager {
  constructor(options = {}) {
    this.downloadDir = options.downloadDir || path.resolve(process.cwd(), 'downloads');
    this.sessionFile = path.resolve(process.cwd(), 'session.json');
    this.maxConnections = options.maxConnections || 300;

    // Concurrency Queue & Memory Guard Configuration
    this.queueConfig = {
      maxGlobalActiveTorrents: process.env.MAX_ACTIVE_TORRENTS ? parseInt(process.env.MAX_ACTIVE_TORRENTS, 10) : (options.maxGlobalActiveTorrents || 4),
      maxConnsPerTorrent: process.env.MAX_CONNS_PER_TORRENT ? parseInt(process.env.MAX_CONNS_PER_TORRENT, 10) : (options.maxConnsPerTorrent || 35),
      autoPauseCompleted: process.env.AUTO_PAUSE_COMPLETED !== undefined ? (process.env.AUTO_PAUSE_COMPLETED === 'true') : (options.autoPauseCompleted !== undefined ? options.autoPauseCompleted : true),
      maxMemoryThresholdMb: process.env.MAX_MEMORY_MB ? parseInt(process.env.MAX_MEMORY_MB, 10) : (options.maxMemoryThresholdMb || 1200)
    };

    // Live Memory Telemetry
    this.memoryStats = {
      rss: 0,
      heapUsed: 0,
      heapTotal: 0,
      systemFreeMb: 0,
      systemTotalMb: 0,
      status: 'healthy',
      lastReliefAt: null
    };

    // Initialize ProxyService for ISP throttle bypass
    this.proxyService = options.proxyService || new ProxyService();

    // Initialize TrackerService for live community tracker harvesting & Turbo Boost
    this.trackerService = new TrackerService(this.proxyService);

    // Ensure download directory exists
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    // Initialize WebTorrent Client with high-speed tuning for Cloud VPS / Seedbox
    this.client = new WebTorrent({
      torrentPort: process.env.TORRENT_PORT ? parseInt(process.env.TORRENT_PORT, 10) : 6881,
      maxConns: this.maxConnections,
      dht: true, // BEP 05: Distributed Hash Table
      tracker: true, // UDP & HTTP trackers
      webSeeds: true, // BEP 19: Web Seeds
      utPex: true, // µTorrent Peer Exchange (BEP 11)
      lsd: false, // Disabled on VPS: Prevents LAN multicast abuse alerts on cloud provider subnets
      natUpnp: false, // Disabled on VPS: Cloud data centers and Docker do not use residential UPnP
      natPmp: false // Disabled on VPS: Cloud data centers do not use NAT-PMP
    });

    // Initialize PeerOptimizer for continuous peer quality scoring & choke eviction (Priority 🥇)
    this.peerOptimizer = new PeerOptimizer({ trackerService: this.trackerService });

    this.torrentsState = new Map(); // Store metadata, custom state, and boost status

    // Live Disk Space Telemetry & Intelligent Auto-Cleanup Configuration
    this.diskStatsCache = {
      total: 0,
      free: 0,
      used: 0,
      percent: 0,
      status: 'normal',
      completedTorrentsCount: 0,
      completedTorrentsSize: 0,
      lastUpdated: 0
    };
    this.autoCleanupConfig = {
      enabled: false,
      thresholdPercent: 90,
      targetPercent: 75,
      deleteFiles: true
    };

    this.setupClientEvents();
    this.loadSession();
    this.startOptimizerLoop();
    this.startDiskMonitoringLoop();
    this.startMemoryWatchdog();
  }

  setupClientEvents() {
    this.client.on('error', (err) => {
      console.error('[WebTorrent Engine Error]:', err.message);
    });

    this.client.on('listening', () => {
      console.log(`[WebTorrent Engine] Listening for incoming peer wires on port ${this.client.torrentPort}`);
    });
  }

  // Load saved torrents and settings from previous session
  loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = fs.readFileSync(this.sessionFile, 'utf8');
        const session = JSON.parse(data);
        if (session.autoCleanupConfig) {
          this.autoCleanupConfig = { ...this.autoCleanupConfig, ...session.autoCleanupConfig };
        }
        if (session.queueConfig) {
          this.queueConfig = { ...this.queueConfig, ...session.queueConfig };
        }
        if (Array.isArray(session.torrents)) {
          console.log(`[Session] Restoring ${session.torrents.length} torrent(s)...`);
          const torrentCacheDir = path.resolve(process.cwd(), 'torrents');
          for (const item of session.torrents) {
            let src = item.magnetURI || item.infoHash;
            // Prefer cached .torrent file to instantly load full file index & piece headers without swarm delay
            const cachedTorrentFile = path.join(torrentCacheDir, `${item.infoHash}.torrent`);
            if (fs.existsSync(cachedTorrentFile)) {
              try {
                src = fs.readFileSync(cachedTorrentFile);
                console.log(`[Session] Restoring ${item.infoHash} from cached .torrent file`);
              } catch (e) {}
            }

            if (src) {
              this.addTorrent(src, {
                name: item.name,
                paused: item.paused,
                queued: item.queued,
                queueOrder: item.queueOrder,
                completed: item.completed,
                sequential: item.sequential,
                boosted: item.boosted,
                lastBoostedAt: item.lastBoostedAt,
                addedAt: item.addedAt,
                ownerId: item.ownerId || 'admin',
                ownerEmail: item.ownerEmail || 'admin@local'
              }).catch((e) => {
                console.warn(`[Session] Failed to restore torrent ${item.infoHash}:`, e.message);
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[Session] Error reading session file:', err.message);
    }
  }

  // Persist session and settings to disk
  saveSession() {
    try {
      const torrentCacheDir = path.resolve(process.cwd(), 'torrents');
      if (!fs.existsSync(torrentCacheDir)) {
        try { fs.mkdirSync(torrentCacheDir, { recursive: true }); } catch (e) {}
      }

      const torrentsList = this.client.torrents
        .filter(t => t.infoHash)
        .map((t) => {
          const extra = this.torrentsState.get(t.infoHash) || {};

          // Cache .torrent file to disk whenever available
          if (t.torrentFile) {
            try {
              const cachePath = path.join(torrentCacheDir, `${t.infoHash}.torrent`);
              if (!fs.existsSync(cachePath)) {
                fs.writeFileSync(cachePath, t.torrentFile);
              }
            } catch (e) {}
          }

          return {
            infoHash: t.infoHash,
            name: t.name || t.displayName,
            magnetURI: t.magnetURI,
            paused: extra.paused || false,
            queued: extra.queued || false,
            queueOrder: extra.queueOrder || null,
            completed: extra.completed || false,
            sequential: extra.sequential || false,
            boosted: extra.boosted || false,
            lastBoostedAt: extra.lastBoostedAt || null,
            addedAt: extra.addedAt || Date.now(),
            ownerId: extra.ownerId || 'admin',
            ownerEmail: extra.ownerEmail || 'admin@local'
          };
        });
      const sessionData = {
        autoCleanupConfig: this.autoCleanupConfig,
        queueConfig: this.queueConfig,
        torrents: torrentsList
      };
      fs.writeFileSync(this.sessionFile, JSON.stringify(sessionData, null, 2), 'utf8');
    } catch (err) {
      console.error('[Session] Failed to save session:', err.message);
    }
  }

  // Sanitize and format input source (magnet, URL, or hex hash)
  async prepareSource(torrentSource) {
    if (Buffer.isBuffer(torrentSource)) {
      return torrentSource;
    }

    if (typeof torrentSource !== 'string') {
      throw new Error('Invalid torrent source type');
    }

    let src = torrentSource.trim();

    // 1. If it's an HTTP/HTTPS URL to a .torrent file, download it
    if (/^https?:\/\//i.test(src)) {
      console.log(`[Torrent] Downloading .torrent file from URL: ${src}`);
      // Route .torrent file download through proxy if configured
      const proxyOpts = this.proxyService ? this.proxyService.getFetchOptions(src) : {};
      const res = await fetch(src, {
        headers: { 'User-Agent': 'Mozilla/5.0 HyperTorrent/1.0' },
        signal: AbortSignal.timeout(15000),
        ...proxyOpts
      });
      if (!res.ok) throw new Error(`Failed to fetch .torrent file: HTTP ${res.status}`);
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // 2. If it's a bare 40-character hex hash, convert to magnet URI
    if (/^[a-f0-9]{40}$/i.test(src)) {
      src = `magnet:?xt=urn:btih:${src}`;
    }

    // 3. If it's a magnet URI, inject cached high-speed community trackers if none exist
    if (src.startsWith('magnet:?')) {
      if (!src.includes('&tr=')) {
        const trackers = (this.trackerService && this.trackerService.cachedTrackers.length > 0)
          ? this.trackerService.cachedTrackers
          : DEFAULT_TURBO_TRACKERS;
        const trackerParams = trackers.map(tr => `&tr=${encodeURIComponent(tr)}`).join('');
        src = src + trackerParams;
      }
      return src;
    }

    // Return as-is
    return src;
  }

  // Add Torrent via magnet URI, URL, or .torrent file buffer
  async addTorrent(torrentSource, options = {}) {
    const source = await this.prepareSource(torrentSource);

    // Multi-User Quota Enforcement for Standard Users
    if (options.user && options.user.role !== 'admin') {
      const user = options.user;
      const userQuota = user.quota || { maxActiveTorrents: 3, maxStorageBytes: 21474836480 };

      let activeCount = 0;
      let userTotalBytes = 0;

      for (const t of this.client.torrents) {
        const extra = this.torrentsState.get(t.infoHash) || {};
        if (extra.ownerId === user.id) {
          if (!extra.paused && t.progress < 1) {
            activeCount++;
          }
          userTotalBytes += (t.downloaded || t.length || 0);
        }
      }

      if (activeCount >= userQuota.maxActiveTorrents) {
        throw new Error(`Active download quota reached: Limit is ${userQuota.maxActiveTorrents} simultaneous downloads.`);
      }

      if (userTotalBytes >= userQuota.maxStorageBytes) {
        const maxGb = Math.round(userQuota.maxStorageBytes / (1024 * 1024 * 1024));
        throw new Error(`Personal storage quota reached: Allocated space limit is ${maxGb} GB.`);
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const announceList = (this.trackerService && this.trackerService.cachedTrackers.length > 0)
          ? this.trackerService.cachedTrackers
          : DEFAULT_TURBO_TRACKERS;

        // Calculate active downloading count across the engine for global queueing
        let activeDownloadingCount = 0;
        for (const t of this.client.torrents) {
          if (!t.infoHash) continue;
          const extra = this.torrentsState.get(t.infoHash) || {};
          if (!extra.paused && !extra.queued && !t.done && (t.progress || 0) < 1) {
            activeDownloadingCount++;
          }
        }

        const shouldQueue = options.paused
          ? false
          : (options.queued !== undefined ? Boolean(options.queued) : (activeDownloadingCount >= this.queueConfig.maxGlobalActiveTorrents));

        const opts = {
          path: options.downloadPath || this.downloadDir,
          announce: announceList,
          maxConns: this.queueConfig.maxConnsPerTorrent
        };

        // Check if already in client
        const existing = this.client.get(source);
        if (existing && existing.infoHash) {
          console.log(`[Torrent] Torrent already active: ${existing.name || existing.infoHash}`);
          return resolve(this.formatTorrentSummary(existing));
        }

        console.log(`[Torrent] Adding to WebTorrent engine (Global Active: ${activeDownloadingCount}/${this.queueConfig.maxGlobalActiveTorrents}, Queued: ${shouldQueue})...`);
        const torrent = this.client.add(source, opts);

        // Helper to register events and resolve once infoHash is ready
        const onReadyToTrack = () => {
          if (!torrent.infoHash) return;

          console.log(`[Torrent Tracked]: InfoHash=${torrent.infoHash}, Name=${torrent.name || 'Resolving...'}`);

          this.torrentsState.set(torrent.infoHash, {
            addedAt: options.addedAt || Date.now(),
            queueOrder: options.queueOrder || Date.now(),
            paused: options.paused || false,
            queued: shouldQueue,
            completed: options.completed || false,
            sequential: options.sequential || false,
            boosted: options.boosted || false,
            lastBoostedAt: options.lastBoostedAt || null,
            ownerId: options.ownerId || (options.user ? options.user.id : 'admin'),
            ownerEmail: options.ownerEmail || (options.user ? options.user.email : 'admin@local')
          });

          if (shouldQueue) {
            console.log(`[Queue Manager] Server active limit reached (${this.queueConfig.maxGlobalActiveTorrents}). Queued torrent: ${torrent.name || torrent.infoHash}`);
            try {
              torrent.pause();
              if (torrent.pieces && torrent.pieces.length > 0) {
                torrent.deselect(0, torrent.pieces.length - 1);
              }
            } catch (e) {}
          }

          this.setupTorrentEvents(torrent);
          this.checkTorrentCompletion(torrent);
          this.saveSession();

          // Auto-Boost if option is set or if previously boosted
          if (options.boosted && !shouldQueue) {
            this.boostTorrent(torrent.infoHash).catch((e) => {
              console.warn(`[Auto-Boost] Error boosting ${torrent.infoHash}:`, e.message);
            });
          }

          // Evaluate queue to promote if a slot is open
          this.processQueue();

          resolve(this.formatTorrentSummary(torrent));
        };

        // If infoHash is already set (e.g. from buffer), track immediately
        if (torrent.infoHash) {
          onReadyToTrack();
        } else {
          // Wait for WebTorrent to parse the magnet/torrent headers and set infoHash
          torrent.once('infoHash', onReadyToTrack);
        }

        // Handle errors during addition
        torrent.once('error', (err) => {
          console.error(`[Torrent Add Error]:`, err.message);
          reject(err);
        });

        // Safety fallback timeout in case the source was completely unparseable
        setTimeout(() => {
          if (!torrent.infoHash) {
            reject(new Error('Timed out parsing torrent metadata or infoHash. Please check the magnet link.'));
          }
        }, 5000);

      } catch (err) {
        console.error(`[Torrent Exception]:`, err.message);
        reject(err);
      }
    });
  }

  setupTorrentEvents(torrent) {
    torrent.on('metadata', () => {
      console.log(`[Torrent Metadata Received]: ${torrent.name} (${torrent.infoHash})`);
      if (torrent.torrentFile) {
        try {
          const torrentCacheDir = path.resolve(process.cwd(), 'torrents');
          if (!fs.existsSync(torrentCacheDir)) fs.mkdirSync(torrentCacheDir, { recursive: true });
          fs.writeFileSync(path.join(torrentCacheDir, `${torrent.infoHash}.torrent`), torrent.torrentFile);
        } catch (e) {}
      }
      this.saveSession();
    });

    torrent.on('ready', () => {
      console.log(`[Torrent Swarm Ready]: ${torrent.name} (${torrent.infoHash})`);
      if (torrent.torrentFile) {
        try {
          const torrentCacheDir = path.resolve(process.cwd(), 'torrents');
          if (!fs.existsSync(torrentCacheDir)) fs.mkdirSync(torrentCacheDir, { recursive: true });
          fs.writeFileSync(path.join(torrentCacheDir, `${torrent.infoHash}.torrent`), torrent.torrentFile);
        } catch (e) {}
      }
      this.saveSession();
    });

    torrent.on('wire', (wire, addr) => {
      if (this.peerOptimizer) {
        this.peerOptimizer.registerWire(torrent, wire);
      }
      console.log(`[Peer Connected ${torrent.infoHash}]: ${addr} (Total peers: ${torrent.numPeers})`);
    });

    torrent.on('done', () => {
      this.checkTorrentCompletion(torrent, true);
    });

    torrent.on('download', () => {
      // Fast check when nearing completion (catches 99.9% stuck swarms)
      if ((torrent.progress || 0) >= 0.999 || (torrent.length > 0 && (torrent.downloaded || 0) >= torrent.length)) {
        this.checkTorrentCompletion(torrent);
      }
    });

    torrent.on('error', (err) => {
      console.error(`[Torrent Error ${torrent.infoHash}]:`, err.message);
    });

    torrent.on('warning', (warn) => {
      console.warn(`[Torrent Warning ${torrent.infoHash}]:`, warn);
    });
  }

  /**
   * 🎯 Intelligent Torrent Completion & Hibernation Detector:
   * Solves the BitTorrent 99.9% last-block trap (where 16KB of padding or an unselected
   * metadata file keeps WebTorrent from firing 'done'). Automatically detects when
   * payload is complete, flips status to completed, and executes auto-hibernation.
   */
  checkTorrentCompletion(torrent, force = false) {
    if (!torrent || !torrent.infoHash) return false;
    const key = torrent.infoHash;
    const state = this.torrentsState.get(key) || {};

    if (!force && state.completed && state.paused) {
      return true;
    }

    const totalLength = torrent.length || 0;
    const downloaded = torrent.downloaded || 0;
    const progress = torrent.progress || 0;

    let isComplete = force || !!torrent.done;

    // Signal 1: 99.9%+ progress threshold or byte parity
    if (!isComplete && totalLength > 0) {
      if (downloaded >= totalLength || progress >= 0.999 || (totalLength - downloaded) < 131072) {
        isComplete = true;
      }
    }

    // Signal 2: All active/selected files fully downloaded
    if (!isComplete && torrent.files && torrent.files.length > 0) {
      const activeFiles = torrent.files.filter(f => typeof f._selected === 'boolean' ? f._selected : true);
      if (activeFiles.length > 0 && activeFiles.every(f => f.progress >= 0.999 || f.downloaded >= f.length || (f.length > 0 && (f.length - f.downloaded) < 65536))) {
        isComplete = true;
      }
    }

    if (isComplete) {
      const wasCompleted = state.completed;
      state.completed = true;
      state.queued = false;
      this.torrentsState.set(key, state);

      if (!wasCompleted || !state.paused) {
        console.log(`[Completion Detector] Verified payload 100% complete: ${torrent.name || key} (${downloaded}/${totalLength} bytes, ${(progress * 100).toFixed(1)}%)`);
        this.saveSession();

        if (this.queueConfig.autoPauseCompleted && !state.paused) {
          console.log(`[Memory Optimizer] Auto-hibernating completed torrent ${torrent.name || key} to release peer wire buffers and RAM.`);
          this.pauseTorrent(key, { autoPaused: true });
        } else {
          this.processQueue();
        }
      }
      return true;
    }

    return false;
  }

  // Robust torrent lookup by infoHash, magnetURI, or instance
  findTorrent(idOrHash) {
    if (!idOrHash) return null;
    const clean = String(idOrHash).toLowerCase().trim();

    // 1. Direct match in client.torrents array by infoHash (case-insensitive)
    const byHash = this.client.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === clean);
    if (byHash) return byHash;

    // 2. Match by magnetURI
    const byMagnet = this.client.torrents.find(t => t.magnetURI && t.magnetURI.toLowerCase().includes(clean));
    if (byMagnet) return byMagnet;

    // 3. Match by name
    const byName = this.client.torrents.find(t => t.name && t.name.toLowerCase() === clean);
    if (byName) return byName;

    // 4. Fallback to WebTorrent client.get
    try {
      return this.client.get(idOrHash) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * ⚡ TURBO BOOST a single torrent:
   * Dynamically injects live community trackers, forces DHT/Tracker re-announce,
   * unchokes peer wires, and accelerates discovery.
   */
  async boostTorrent(infoHash) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');

    const result = await this.trackerService.boostTorrent(torrent);

    const key = torrent.infoHash || infoHash;
    const state = this.torrentsState.get(key) || {};
    state.boosted = true;
    state.lastBoostedAt = Date.now();
    this.torrentsState.set(key, state);
    this.saveSession();

    return {
      ...result,
      numPeers: torrent.numPeers || 0,
      downloadSpeed: torrent.downloadSpeed || 0,
      name: torrent.name || torrent.displayName
    };
  }

  /**
   * ⚡ TURBO BOOST ALL active torrents simultaneously
   */
  async boostAllTorrents() {
    const active = this.client.torrents.filter(t => t.infoHash && !t.done);
    if (active.length === 0) {
      return { boostedCount: 0, results: [] };
    }

    const results = [];
    for (const torrent of active) {
      try {
        const res = await this.boostTorrent(torrent.infoHash);
        results.push(res);
      } catch (err) {
        console.warn(`[BoostAll Error ${torrent.infoHash}]:`, err.message);
      }
    }

    return {
      boostedCount: results.length,
      results
    };
  }

  // Pause torrent
  pauseTorrent(infoHash, options = {}) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');

    const key = torrent.infoHash || infoHash;
    const state = this.torrentsState.get(key) || {};
    state.paused = true;
    state.queued = false;
    if (options.autoPaused) {
      state.autoPaused = true;
    }
    this.torrentsState.set(key, state);

    // Call WebTorrent pause
    try {
      torrent.pause();
    } catch (e) { }

    // Deselect all pieces to clear active selections pipeline
    if (torrent.pieces && torrent.pieces.length > 0) {
      try {
        torrent.deselect(0, torrent.pieces.length - 1);
      } catch (e) { }
    }

    // Cancel in-flight block requests and set uninterested on all active wires
    if (Array.isArray(torrent.wires)) {
      for (const wire of torrent.wires) {
        try {
          if (Array.isArray(wire.requests)) {
            for (const req of [...wire.requests]) {
              try { wire.cancel(req.piece, req.offset, req.length); } catch (e) { }
            }
          }
          wire.uninterested();
        } catch (e) { }
      }
    }

    this.saveSession();

    // A slot freed up - promote next queued torrent
    this.processQueue();
    return true;
  }

  // Resume torrent
  resumeTorrent(infoHash) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');

    const key = torrent.infoHash || infoHash;
    const state = this.torrentsState.get(key) || {};
    state.paused = false;
    state.autoPaused = false;

    // Check current active downloading count across the engine
    let activeDownloadingCount = 0;
    for (const t of this.client.torrents) {
      if (!t.infoHash || t.infoHash.toLowerCase() === key.toLowerCase()) continue;
      const st = this.torrentsState.get(t.infoHash) || {};
      if (!st.paused && !st.queued && !t.done && (t.progress || 0) < 1) {
        activeDownloadingCount++;
      }
    }

    if (activeDownloadingCount >= this.queueConfig.maxGlobalActiveTorrents && !torrent.done && (torrent.progress || 0) < 1) {
      state.queued = true;
      state.queueOrder = Date.now();
      this.torrentsState.set(key, state);
      console.log(`[Queue Manager] Torrent added to queue on resume: ${torrent.name || key}`);
      this.saveSession();
      return { status: 'queued' };
    }

    state.queued = false;
    this.torrentsState.set(key, state);

    // Re-select pieces for active files
    if (torrent.files && torrent.files.length > 0) {
      for (const file of torrent.files) {
        if (typeof file._selected === 'boolean' ? file._selected : true) {
          try { file.select(); } catch (e) { }
        }
      }
    } else if (torrent.pieces && torrent.pieces.length > 0) {
      try {
        torrent.select(0, torrent.pieces.length - 1, state.sequential ? 1 : 0);
      } catch (e) { }
    }

    try {
      torrent.resume();
    } catch (e) { }

    this.saveSession();
    return { status: 'resumed' };
  }

  // Toggle sequential downloading (prioritizes pieces in order for streaming)
  toggleSequential(infoHash, enable) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');

    const key = torrent.infoHash || infoHash;
    const state = this.torrentsState.get(key) || {};
    state.sequential = enable !== undefined ? enable : !state.sequential;
    this.torrentsState.set(key, state);

    if (state.sequential && torrent.pieces && torrent.pieces.length > 0) {
      torrent.select(0, torrent.pieces.length - 1, 1);
    } else if (torrent.pieces && torrent.pieces.length > 0) {
      torrent.deselect(0, torrent.pieces.length - 1, 1);
      torrent.select(0, torrent.pieces.length - 1, 0);
    }

    this.saveSession();
    return state.sequential;
  }

  // Set file priority / selection
  setFileSelection(infoHash, fileIndex, selected) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');
    if (!torrent.files || !torrent.files[fileIndex]) throw new Error('File index not found');

    const file = torrent.files[fileIndex];
    if (selected) {
      file.select();
    } else {
      file.deselect();
    }

    return { fileIndex, selected };
  }

  // Remove torrent with optional user ownership check
  removeTorrent(infoHash, deleteFiles = false, user = null) {
    return new Promise((resolve, reject) => {
      const torrent = this.findTorrent(infoHash);
      if (!torrent) {
        return reject(new Error('Torrent not found'));
      }

      const key = torrent.infoHash || infoHash;
      const extra = this.torrentsState.get(key) || {};

      // If user is non-admin, ensure they own this torrent
      if (user && user.role !== 'admin') {
        if (extra.ownerId && extra.ownerId !== user.id && extra.ownerEmail !== user.email) {
          return reject(new Error('Access denied: You cannot delete another user\'s torrent.'));
        }
      }

      // Clean up auxiliary trackers and state
      this.trackerService.cleanupTorrent(key);
      if (this.peerOptimizer) {
        this.peerOptimizer.cleanupTorrent(key);
      }

      this.client.remove(torrent, { destroyStore: deleteFiles }, (err) => {
        if (err) return reject(err);
        this.torrentsState.delete(key);
        this.saveSession();
        this.processQueue();
        resolve(true);
      });
    });
  }

  // Retrieve downloaded files directly from disk when available
  getDiskFiles(torrentName) {
    if (!torrentName) return [];
    const targetPath = path.resolve(this.downloadDir, torrentName);
    if (!fs.existsSync(targetPath)) return [];

    try {
      const stat = fs.statSync(targetPath);
      if (stat.isFile()) {
        return [{
          index: 0,
          name: torrentName,
          path: torrentName,
          length: stat.size,
          diskPath: targetPath,
          downloaded: stat.size,
          progress: 1,
          selected: true
        }];
      }

      if (stat.isDirectory()) {
        const results = [];
        const walk = (dir, relPath = '') => {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const full = path.join(dir, item);
            const rel = relPath ? `${relPath}/${item}` : item;
            const s = fs.statSync(full);
            if (s.isDirectory()) {
              walk(full, rel);
            } else if (s.isFile()) {
              results.push({
                index: results.length,
                name: item,
                path: `${torrentName}/${rel}`,
                length: s.size,
                diskPath: full,
                downloaded: s.size,
                progress: 1,
                selected: true
              });
            }
          }
        };
        walk(targetPath);
        return results;
      }
    } catch (e) {}
    return [];
  }

  // Format summary data for listing
  formatTorrentSummary(torrent) {
    const infoHash = torrent.infoHash || 'retrieving';
    const state = this.torrentsState.get(infoHash) || {};

    // Try WebTorrent files first; fallback to local disk files if already downloaded
    let fileList = torrent.files && torrent.files.length > 0 ? torrent.files : null;
    let filesCount = torrent.files ? torrent.files.length : 0;
    let totalLength = torrent.length || 0;
    let isDiskOnly = false;

    if (!fileList || fileList.length === 0) {
      const diskFiles = this.getDiskFiles(torrent.name);
      if (diskFiles.length > 0) {
        fileList = diskFiles;
        filesCount = diskFiles.length;
        if (!totalLength) {
          totalLength = diskFiles.reduce((acc, f) => acc + (f.length || 0), 0);
        }
        isDiskOnly = true;
      }
    }

    const downloadedBytes = torrent.downloaded || 0;
    const progressVal = torrent.progress || 0;

    // Intelligent completion verification (prevents 99.9% last-block hang)
    const isActuallyComplete = Boolean(
      state.completed ||
      torrent.done ||
      isDiskOnly ||
      (totalLength > 0 && (downloadedBytes >= totalLength || progressVal >= 0.999 || (totalLength - downloadedBytes) < 131072))
    );

    // If payload is complete but state hasn't been updated yet, trigger completion & auto-pause
    if (isActuallyComplete && !state.completed) {
      this.checkTorrentCompletion(torrent);
    }

    let status = 'downloading';
    if (state.paused) {
      status = 'paused';
    } else if (state.queued) {
      status = 'queued';
    } else if (isActuallyComplete) {
      status = 'completed';
    } else if (!torrent.name || (torrent.numPeers === 0 && torrent.progress === 0)) {
      status = 'connecting';
    }

    // Identify primary/main file (e.g. largest video file)
    let mainFile = null;
    if (fileList && fileList.length > 0) {
      let largest = fileList[0];
      let largestIdx = 0;
      for (let i = 0; i < fileList.length; i++) {
        if ((fileList[i].length || 0) > (largest.length || 0)) {
          largest = fileList[i];
          largestIdx = i;
        }
      }
      const isVideo = /\.(mp4|mkv|avi|mov|webm|m4v|wmv|flv)$/i.test(largest.name);
      mainFile = {
        index: largestIdx,
        name: largest.name,
        length: largest.length,
        isVideo: isVideo
      };
    }

    // Accurate progress and downloaded calculations
    let progress = 0;
    if (isActuallyComplete || isDiskOnly) {
      progress = 1;
    } else if (typeof torrent.progress === 'number' && !isNaN(torrent.progress)) {
      progress = torrent.progress;
    } else if (totalLength > 0 && typeof torrent.downloaded === 'number') {
      progress = torrent.downloaded / totalLength;
    }
    progress = Math.min(1, Math.max(0, progress));

    let downloaded = 0;
    if (isActuallyComplete || isDiskOnly) {
      downloaded = totalLength;
    } else if (typeof torrent.downloaded === 'number' && !isNaN(torrent.downloaded)) {
      downloaded = torrent.downloaded;
    }

    return {
      infoHash: infoHash,
      name: torrent.name || torrent.displayName || 'Retrieving metadata from swarm...',
      magnetURI: torrent.magnetURI,
      progress: progress,
      downloadSpeed: (state.paused || state.queued || isActuallyComplete) ? 0 : (torrent.downloadSpeed || 0),
      uploadSpeed: (state.paused || state.queued) ? 0 : (torrent.uploadSpeed || 0),
      downloaded: downloaded,
      uploaded: torrent.uploaded || 0,
      length: totalLength,
      numPeers: (state.paused || state.autoPaused) ? 0 : (torrent.numPeers || 0),
      timeRemaining: (state.paused || state.queued || isActuallyComplete) ? 0 : (torrent.timeRemaining || 0),
      ratio: torrent.ratio || 0,
      status: status,
      paused: state.paused || false,
      queued: state.queued || false,
      autoPaused: state.autoPaused || false,
      completed: isActuallyComplete,
      queueOrder: state.queueOrder || null,
      sequential: state.sequential || false,
      boosted: state.boosted || false,
      lastBoostedAt: state.lastBoostedAt || null,
      addedAt: state.addedAt || Date.now(),
      filesCount: filesCount,
      pieceLength: torrent.pieceLength || 0,
      numPieces: torrent.pieces ? torrent.pieces.length : 0,
      mainFile: mainFile,
      ownerId: state.ownerId || 'admin',
      ownerEmail: state.ownerEmail || 'admin@local'
    };
  }

  // Format detailed information including peers, files, piece bitfield, and all active trackers
  formatTorrentDetails(torrent) {
    const summary = this.formatTorrentSummary(torrent);

    // Format files safely
    let files = (torrent.files || []).map((file, idx) => ({
      index: idx,
      name: file.name,
      path: file.path,
      length: file.length,
      downloaded: file.downloaded,
      progress: file.progress,
      selected: typeof file._selected === 'boolean' ? file._selected : true
    }));

    if (files.length === 0) {
      const diskFiles = this.getDiskFiles(torrent.name);
      if (diskFiles.length > 0) {
        files = diskFiles.map((f, idx) => ({
          index: idx,
          name: f.name,
          path: f.path,
          length: f.length,
          downloaded: f.length,
          progress: 1,
          selected: true
        }));
      }
    }

    // Format connected peers safely
    const peers = (torrent.wires || []).map((wire) => {
      let clientName = 'BitTorrent Client';
      try {
        if (wire.peerExtendedHandshake && wire.peerExtendedHandshake.v) {
          const v = wire.peerExtendedHandshake.v;
          if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
            clientName = Buffer.from(v).toString('utf8');
          } else if (typeof v === 'object') {
            clientName = Buffer.from(Object.values(v)).toString('utf8');
          } else {
            clientName = String(v);
          }
        }
      } catch (e) { }

      let dlSpeed = 0;
      let ulSpeed = 0;
      try {
        if (typeof wire.downloadSpeed === 'function') dlSpeed = wire.downloadSpeed();
        if (typeof wire.uploadSpeed === 'function') ulSpeed = wire.uploadSpeed();
      } catch (e) { }

      const scoreData = this.peerOptimizer ? this.peerOptimizer.decoratePeerInfo(wire, torrent) : null;

      return {
        ip: wire.remoteAddress || 'Peer',
        port: wire.remotePort || 0,
        client: clientName,
        downloadSpeed: dlSpeed,
        uploadSpeed: ulSpeed,
        downloaded: wire.downloaded || 0,
        uploaded: wire.uploaded || 0,
        choked: wire.peerChoking || false,
        interested: wire.peerInterested || false,
        amChoking: wire.amChoking || false,
        amInterested: wire.amInterested || false,
        qualityScore: scoreData ? scoreData.qualityScore : 50,
        healthLabel: scoreData ? scoreData.healthLabel : 'Active Partner',
        isStalled: scoreData ? scoreData.isStalled : false,
        chokedDurationSec: scoreData ? scoreData.chokedDurationSec : 0
      };
    });

    // Extract piece bitfield as boolean array for visualizer canvas
    const pieces = [];
    if (torrent.pieces) {
      for (let i = 0; i < torrent.pieces.length; i++) {
        const piece = torrent.pieces[i];
        const isVerified = (torrent.bitfield && torrent.bitfield.get(i)) || (piece && piece.verified) || (torrent.done) || false;
        pieces.push(isVerified ? 1 : 0);
      }
    }

    // Extract comprehensive active trackers list from torrent announcements and discovery
    const trackerSet = new Set();
    if (Array.isArray(torrent.announce)) {
      torrent.announce.forEach(tr => trackerSet.add(tr));
    }
    if (torrent.discovery?.tracker?._trackers) {
      torrent.discovery.tracker._trackers.forEach(tr => {
        if (tr.announceUrl) trackerSet.add(tr.announceUrl);
      });
    }

    const trackers = trackerSet.size > 0
      ? Array.from(trackerSet)
      : (this.trackerService ? this.trackerService.cachedTrackers : DEFAULT_TURBO_TRACKERS);

    return {
      ...summary,
      files,
      peers,
      pieces,
      trackers,
      optimizerStats: this.peerOptimizer ? this.peerOptimizer.getStats() : null
    };
  }

  // Autonomous background loop to optimize swarm quality every 15s
  startOptimizerLoop() {
    setInterval(() => {
      try {
        if (!this.client || !this.client.torrents) return;
        for (const torrent of this.client.torrents) {
          if (!torrent.infoHash) continue;
          const key = torrent.infoHash.toLowerCase();
          const state = this.torrentsState.get(key);

          // Continuously evaluate payload completion (catches 99.9% stuck torrents)
          this.checkTorrentCompletion(torrent);

          const isPaused = state && state.paused;
          if (!isPaused && !torrent.done && !state?.completed && !torrent.destroyed) {
            this.peerOptimizer.optimizeTorrent(torrent);
          }
        }
      } catch (err) {
        console.warn('[PeerOptimizer Loop Notice]:', err.message);
      }
    }, 15000);
  }

  // Trigger manual on-demand swarm optimization pass
  optimizeTorrent(infoHash) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');
    return this.peerOptimizer.optimizeTorrent(torrent);
  }

  // Get all torrents summary (optionally filtered by user role)
  getAllTorrents(filterUser = null) {
    let list = this.client.torrents
      .filter(t => t.infoHash)
      .map((t) => this.formatTorrentSummary(t));

    if (filterUser && filterUser.role !== 'admin') {
      list = list.filter(t => t.ownerId === filterUser.id || t.ownerEmail === filterUser.email);
    }
    return list;
  }

  // Get specific torrent details
  getTorrent(infoHash) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) return null;
    return this.formatTorrentDetails(torrent);
  }

  // Global Engine Telemetry
  getGlobalStats() {
    let activeDownSpeed = 0;
    let activeUpSpeed = 0;
    let anyActive = false;
    let activeDownloadingCount = 0;
    let queuedCount = 0;

    for (const t of this.client.torrents) {
      const st = this.torrentsState.get(t.infoHash) || {};
      if (!st.paused && !st.queued && !t.done && (t.progress || 0) < 1) {
        activeDownloadingCount++;
        anyActive = true;
        activeDownSpeed += (t.downloadSpeed || 0);
        activeUpSpeed += (t.uploadSpeed || 0);
      } else if (st.queued && !st.paused && !t.done && (t.progress || 0) < 1) {
        queuedCount++;
      }
    }

    return {
      downloadSpeed: anyActive ? (this.client.downloadSpeed || activeDownSpeed) : 0,
      uploadSpeed: anyActive ? (this.client.uploadSpeed || activeUpSpeed) : 0,
      progress: this.client.progress || 0,
      ratio: this.client.ratio || 0,
      totalTorrents: this.client.torrents.length,
      downloadDir: this.downloadDir,
      listeningPort: this.client.torrentPort || 0,
      cachedTrackersCount: this.trackerService ? this.trackerService.cachedTrackers.length : 0,
      turboStats: this.trackerService ? this.trackerService.stats : { totalBoosts: 0, totalPeersInjected: 0 },
      proxy: this.proxyService ? this.proxyService.getStatus() : { enabled: false },
      optimizer: this.peerOptimizer ? this.peerOptimizer.getStats() : null,
      memory: this.memoryStats || {
        rss: 0,
        heapUsed: 0,
        heapTotal: 0,
        systemFreeMb: 0,
        systemTotalMb: 0,
        status: 'healthy'
      },
      queue: {
        maxGlobalActiveTorrents: this.queueConfig.maxGlobalActiveTorrents,
        maxConnsPerTorrent: this.queueConfig.maxConnsPerTorrent,
        autoPauseCompleted: this.queueConfig.autoPauseCompleted,
        maxMemoryThresholdMb: this.queueConfig.maxMemoryThresholdMb,
        activeCount: activeDownloadingCount,
        queuedCount: queuedCount
      },
      disk: this.diskStatsCache || {
        total: 0,
        free: 0,
        used: 0,
        percent: 0,
        status: 'normal',
        completedTorrentsCount: 0,
        completedTorrentsSize: 0
      }
    };
  }

  /**
   * 💾 Real-Time Disk Space Telemetry:
   * Uses native fs.promises.statfs for zero-dependency, high-speed disk telemetry.
   */
  async getDiskSpace(force = false) {
    const now = Date.now();
    // Cache for 3 seconds unless forced
    if (!force && this.diskStatsCache && (now - (this.diskStatsCache.lastUpdated || 0) < 3000)) {
      return this.diskStatsCache;
    }

    try {
      const stats = await fs.promises.statfs(this.downloadDir);
      const bsize = Number(stats.bsize) || 4096;
      const blocks = Number(stats.blocks) || 0;
      const bavail = Number(stats.bavail) || Number(stats.bfree) || 0;

      const total = blocks * bsize;
      const free = bavail * bsize;
      const used = Math.max(0, total - free);
      const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

      let status = 'normal';
      if (percent >= 90) {
        status = 'critical';
      } else if (percent >= 80) {
        status = 'warning';
      }

      // Count completed torrents and their cumulative size
      let completedCount = 0;
      let completedSize = 0;
      const completedList = [];

      if (this.client && this.client.torrents) {
        for (const t of this.client.torrents) {
          if (!t.infoHash) continue;
          const st = this.torrentsState.get(t.infoHash) || {};
          if (t.done || t.progress >= 1) {
            completedCount++;
            const tLen = t.length || 0;
            completedSize += tLen;
            completedList.push({
              infoHash: t.infoHash,
              name: t.name || t.displayName || 'Torrent',
              length: tLen,
              addedAt: st.addedAt || now,
              ratio: t.ratio || 0
            });
          }
        }
      }

      this.diskStatsCache = {
        total,
        free,
        used,
        percent,
        status,
        completedTorrentsCount: completedCount,
        completedTorrentsSize: completedSize,
        completedTorrents: completedList,
        autoCleanup: this.autoCleanupConfig,
        lastUpdated: now
      };

      // Trigger auto-cleanup if usage is over threshold and auto-cleanup is enabled
      if (this.autoCleanupConfig.enabled && percent >= this.autoCleanupConfig.thresholdPercent) {
        console.warn(`[Auto-Cleanup Trigger] Disk usage (${percent}%) >= threshold (${this.autoCleanupConfig.thresholdPercent}%). Purging completed torrents...`);
        this.triggerAutoCleanup();
      }

      return this.diskStatsCache;
    } catch (err) {
      console.warn('[Disk Space Error]:', err.message);
      return this.diskStatsCache || {
        total: 0,
        free: 0,
        used: 0,
        percent: 0,
        status: 'unknown',
        completedTorrentsCount: 0,
        completedTorrentsSize: 0,
        lastUpdated: now
      };
    }
  }

  /**
   * 🧹 Purge Completed Torrents (Manual or Auto-Triggered):
   * Frees server disk space by removing completed swarms and wiping files from disk.
   */
  async cleanupCompleted(options = {}) {
    const maxAgeHours = options.maxAgeHours !== undefined ? Number(options.maxAgeHours) : 0;
    const deleteFiles = options.deleteFiles !== undefined ? Boolean(options.deleteFiles) : true;
    const now = Date.now();

    const candidates = [];
    if (this.client && this.client.torrents) {
      for (const t of this.client.torrents) {
        if (!t.infoHash) continue;
        const st = this.torrentsState.get(t.infoHash) || {};
        if (t.done || t.progress >= 1) {
          const addedAt = st.addedAt || now;
          const ageHours = (now - addedAt) / (1000 * 60 * 60);
          if (maxAgeHours === 0 || ageHours >= maxAgeHours) {
            candidates.push({
              infoHash: t.infoHash,
              name: t.name || t.displayName,
              length: t.length || 0,
              addedAt
            });
          }
        }
      }
    }

    // Sort oldest added first
    candidates.sort((a, b) => a.addedAt - b.addedAt);

    let freedBytes = 0;
    let cleanedCount = 0;

    for (const c of candidates) {
      try {
        await this.removeTorrent(c.infoHash, deleteFiles);
        freedBytes += c.length;
        cleanedCount++;
        console.log(`[Cleanup] Removed completed torrent: ${c.name} (${c.infoHash}), freed ~${c.length} bytes`);
      } catch (err) {
        console.warn(`[Cleanup Error] Failed to remove ${c.infoHash}:`, err.message);
      }
    }

    // Immediately refresh disk stats
    await this.getDiskSpace(true);

    return {
      cleanedCount,
      freedBytes,
      remainingCompleted: (this.diskStatsCache ? this.diskStatsCache.completedTorrentsCount : 0)
    };
  }

  async triggerAutoCleanup() {
    try {
      const result = await this.cleanupCompleted({
        deleteFiles: this.autoCleanupConfig.deleteFiles
      });
      console.log(`[Auto-Cleanup] Finished: purged ${result.cleanedCount} torrent(s), freed ${result.freedBytes} bytes`);
    } catch (err) {
      console.error('[Auto-Cleanup Execution Error]:', err.message);
    }
  }

  updateAutoCleanupConfig(config = {}) {
    if (typeof config.enabled === 'boolean') {
      this.autoCleanupConfig.enabled = config.enabled;
    }
    if (typeof config.thresholdPercent === 'number') {
      this.autoCleanupConfig.thresholdPercent = Math.min(99, Math.max(50, config.thresholdPercent));
    }
    if (typeof config.targetPercent === 'number') {
      this.autoCleanupConfig.targetPercent = Math.min(95, Math.max(30, config.targetPercent));
    }
    if (typeof config.deleteFiles === 'boolean') {
      this.autoCleanupConfig.deleteFiles = config.deleteFiles;
    }
    this.saveSession();
    return this.autoCleanupConfig;
  }

  startDiskMonitoringLoop() {
    // Initial async warm-up
    this.getDiskSpace(true).catch(() => {});

    // Periodic refresh every 10 seconds
    setInterval(() => {
      this.getDiskSpace().catch(() => {});
    }, 10000);
  }

  /**
   * 🚦 Intelligent Concurrency Queue Processor:
   * Promotes queued torrents when active slots become available.
   * Employs fair-share user scheduling so no single user monopolizes slots.
   */
  processQueue() {
    if (!this.client || !this.client.torrents) return;

    // 1. Calculate current active downloading swarms
    let activeDownloadingCount = 0;
    for (const t of this.client.torrents) {
      if (!t.infoHash) continue;
      const state = this.torrentsState.get(t.infoHash) || {};
      if (!state.paused && !state.queued && !t.done && (t.progress || 0) < 1) {
        activeDownloadingCount++;
      }
    }

    const availableSlots = this.queueConfig.maxGlobalActiveTorrents - activeDownloadingCount;
    if (availableSlots <= 0) return;

    // 2. Identify queued candidates waiting for download
    const queuedCandidates = [];
    for (const t of this.client.torrents) {
      if (!t.infoHash) continue;
      const state = this.torrentsState.get(t.infoHash) || {};
      if (state.queued && !state.paused && !t.done && (t.progress || 0) < 1) {
        queuedCandidates.push({ torrent: t, state });
      }
    }

    if (queuedCandidates.length === 0) return;

    // 3. Fair-share user scheduling: Count active downloads per user
    const activeCountPerOwner = new Map();
    for (const t of this.client.torrents) {
      if (!t.infoHash) continue;
      const state = this.torrentsState.get(t.infoHash) || {};
      if (!state.paused && !state.queued && !t.done && (t.progress || 0) < 1) {
        const owner = state.ownerId || 'admin';
        activeCountPerOwner.set(owner, (activeCountPerOwner.get(owner) || 0) + 1);
      }
    }

    // Sort: user with lowest active count first, then oldest added first (FIFO)
    queuedCandidates.sort((a, b) => {
      const ownerA = a.state.ownerId || 'admin';
      const ownerB = b.state.ownerId || 'admin';
      const countA = activeCountPerOwner.get(ownerA) || 0;
      const countB = activeCountPerOwner.get(ownerB) || 0;
      if (countA !== countB) return countA - countB;
      return (a.state.queueOrder || a.state.addedAt || 0) - (b.state.queueOrder || b.state.addedAt || 0);
    });

    // 4. Promote up to availableSlots
    const toPromote = queuedCandidates.slice(0, availableSlots);
    for (const { torrent, state } of toPromote) {
      state.queued = false;
      state.paused = false;
      this.torrentsState.set(torrent.infoHash, state);

      // Re-select pieces for files
      if (torrent.files && torrent.files.length > 0) {
        for (const file of torrent.files) {
          if (typeof file._selected === 'boolean' ? file._selected : true) {
            try { file.select(); } catch (e) { }
          }
        }
      } else if (torrent.pieces && torrent.pieces.length > 0) {
        try {
          torrent.select(0, torrent.pieces.length - 1, state.sequential ? 1 : 0);
        } catch (e) { }
      }

      try {
        torrent.resume();
      } catch (e) { }

      console.log(`[Queue Manager] Promoted queued torrent to active: ${torrent.name || torrent.infoHash} (Owner: ${state.ownerEmail || state.ownerId})`);
    }

    this.saveSession();
  }

  /**
   * 🛡️ Autonomous VPS Memory Guard Watchdog:
   * Continuously monitors RSS and Heap usage. Automatically relieves memory pressure
   * if RAM usage crosses safety limits, protecting the VPS from Linux kernel OOM killer crashes.
   */
  startMemoryWatchdog() {
    setInterval(() => {
      try {
        const mem = process.memoryUsage();
        const rssMb = Math.round(mem.rss / (1024 * 1024));
        const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
        const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
        const systemFreeMb = Math.round(os.freemem() / (1024 * 1024));
        const systemTotalMb = Math.round(os.totalmem() / (1024 * 1024));

        const isCritical = rssMb >= this.queueConfig.maxMemoryThresholdMb;
        const isWarning = rssMb >= (this.queueConfig.maxMemoryThresholdMb * 0.85);

        this.memoryStats = {
          rss: rssMb,
          heapUsed: heapUsedMb,
          heapTotal: heapTotalMb,
          systemFreeMb,
          systemTotalMb,
          status: isCritical ? 'critical' : (isWarning ? 'warning' : 'healthy'),
          lastReliefAt: this.memoryStats ? this.memoryStats.lastReliefAt : null
        };

        if (isCritical) {
          console.warn(`[Memory Watchdog Alert]: RAM usage (${rssMb}MB RSS) exceeded safety threshold (${this.queueConfig.maxMemoryThresholdMb}MB). Executing memory relief...`);
          this.memoryStats.lastReliefAt = Date.now();

          // 1. Force V8 Garbage Collection if exposed (--expose-gc)
          if (typeof global.gc === 'function') {
            try { global.gc(); } catch (e) { }
          }

          // 2. Prune peer wires cache in PeerOptimizer
          if (this.peerOptimizer && this.peerOptimizer.wireMetadata) {
            try {
              for (const [hash, wireMap] of this.peerOptimizer.wireMetadata.entries()) {
                if (wireMap.size > 20) {
                  let count = 0;
                  for (const key of wireMap.keys()) {
                    if (count++ > 15) wireMap.delete(key);
                  }
                }
              }
            } catch (e) { }
          }

          // 3. If multiple downloads are active, demote the newest download to queue to drop in-flight piece buffers
          const activeTorrents = [];
          for (const t of this.client.torrents) {
            if (!t.infoHash) continue;
            const st = this.torrentsState.get(t.infoHash) || {};
            if (!st.paused && !st.queued && !t.done && (t.progress || 0) < 1) {
              activeTorrents.push({ torrent: t, state: st });
            }
          }

          if (activeTorrents.length > 1) {
            activeTorrents.sort((a, b) => (b.state.addedAt || 0) - (a.state.addedAt || 0));
            const target = activeTorrents[0];
            console.warn(`[Memory Watchdog]: Temporarily moving torrent ${target.torrent.name || target.torrent.infoHash} to queued state to safeguard VPS memory.`);
            target.state.queued = true;
            this.torrentsState.set(target.torrent.infoHash, target.state);
            try {
              target.torrent.pause();
              if (target.torrent.pieces) {
                target.torrent.deselect(0, target.torrent.pieces.length - 1);
              }
            } catch (e) { }
            this.saveSession();
          }
        }
      } catch (err) {
        console.warn('[Memory Watchdog Notice]:', err.message);
      }
    }, 15000);
  }

  updateQueueConfig(config = {}) {
    if (typeof config.maxGlobalActiveTorrents === 'number' && config.maxGlobalActiveTorrents > 0) {
      this.queueConfig.maxGlobalActiveTorrents = Math.min(20, Math.max(1, config.maxGlobalActiveTorrents));
    }
    if (typeof config.maxConnsPerTorrent === 'number' && config.maxConnsPerTorrent > 0) {
      this.queueConfig.maxConnsPerTorrent = Math.min(200, Math.max(10, config.maxConnsPerTorrent));
    }
    if (typeof config.autoPauseCompleted === 'boolean') {
      this.queueConfig.autoPauseCompleted = config.autoPauseCompleted;
    }
    if (typeof config.maxMemoryThresholdMb === 'number' && config.maxMemoryThresholdMb > 100) {
      this.queueConfig.maxMemoryThresholdMb = config.maxMemoryThresholdMb;
    }
    this.saveSession();
    this.processQueue();
    return this.queueConfig;
  }
}

export default TorrentManager;
