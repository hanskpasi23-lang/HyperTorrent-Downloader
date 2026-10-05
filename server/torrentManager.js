import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import TrackerService, { DEFAULT_TURBO_TRACKERS } from './trackerService.js';

export class TorrentManager {
  constructor(options = {}) {
    this.downloadDir = options.downloadDir || path.resolve(process.cwd(), 'downloads');
    this.sessionFile = path.resolve(process.cwd(), 'session.json');
    this.maxConnections = options.maxConnections || 300;
    
    // Initialize TrackerService for live community tracker harvesting & Turbo Boost
    this.trackerService = new TrackerService();

    // Ensure download directory exists
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }

    // Initialize WebTorrent Client with high-speed tuning & NAT traversal
    this.client = new WebTorrent({
      maxConns: this.maxConnections,
      dht: true, // BEP 05: Distributed Hash Table
      tracker: true, // UDP & HTTP trackers
      webSeeds: true, // BEP 19: Web Seeds
      lsd: true, // Local Peer Discovery
      utPex: true, // µTorrent Peer Exchange (BEP 11)
      natUpnp: true, // UPnP automatic router port forward
      natPmp: true // NAT-PMP port mapping
    });

    this.torrentsState = new Map(); // Store metadata, custom state, and boost status
    this.setupClientEvents();
    this.loadSession();
  }

  setupClientEvents() {
    this.client.on('error', (err) => {
      console.error('[WebTorrent Engine Error]:', err.message);
    });

    this.client.on('listening', () => {
      console.log(`[WebTorrent Engine] Listening for incoming peer wires on port ${this.client.torrentPort}`);
    });
  }

  // Load saved torrents from previous session
  loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        const data = fs.readFileSync(this.sessionFile, 'utf8');
        const session = JSON.parse(data);
        if (Array.isArray(session.torrents)) {
          console.log(`[Session] Restoring ${session.torrents.length} torrent(s)...`);
          for (const item of session.torrents) {
            const src = item.magnetURI || item.infoHash;
            if (src) {
              this.addTorrent(src, {
                name: item.name,
                paused: item.paused,
                sequential: item.sequential,
                boosted: item.boosted,
                lastBoostedAt: item.lastBoostedAt
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

  // Persist session to disk
  saveSession() {
    try {
      const torrentsList = this.client.torrents
        .filter(t => t.infoHash)
        .map((t) => {
          const extra = this.torrentsState.get(t.infoHash) || {};
          return {
            infoHash: t.infoHash,
            name: t.name || t.displayName,
            magnetURI: t.magnetURI,
            paused: extra.paused || false,
            sequential: extra.sequential || false,
            boosted: extra.boosted || false,
            lastBoostedAt: extra.lastBoostedAt || null,
            addedAt: extra.addedAt || Date.now()
          };
        });
      fs.writeFileSync(this.sessionFile, JSON.stringify({ torrents: torrentsList }, null, 2), 'utf8');
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
      const res = await fetch(src, {
        headers: { 'User-Agent': 'Mozilla/5.0 HyperTorrent/1.0' },
        signal: AbortSignal.timeout(15000)
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

    return new Promise((resolve, reject) => {
      try {
        const announceList = (this.trackerService && this.trackerService.cachedTrackers.length > 0)
          ? this.trackerService.cachedTrackers
          : DEFAULT_TURBO_TRACKERS;

        const opts = {
          path: options.downloadPath || this.downloadDir,
          announce: announceList
        };

        // Check if already in client
        const existing = this.client.get(source);
        if (existing && existing.infoHash) {
          console.log(`[Torrent] Torrent already active: ${existing.name || existing.infoHash}`);
          return resolve(this.formatTorrentSummary(existing));
        }

        console.log(`[Torrent] Adding to WebTorrent engine...`);
        const torrent = this.client.add(source, opts);

        // Helper to register events and resolve once infoHash is ready
        const onReadyToTrack = () => {
          if (!torrent.infoHash) return;

          console.log(`[Torrent Tracked]: InfoHash=${torrent.infoHash}, Name=${torrent.name || 'Resolving...'}`);
          
          this.torrentsState.set(torrent.infoHash, {
            addedAt: options.addedAt || Date.now(),
            paused: options.paused || false,
            sequential: options.sequential || false,
            boosted: options.boosted || false,
            lastBoostedAt: options.lastBoostedAt || null
          });

          this.setupTorrentEvents(torrent);
          this.saveSession();

          // Auto-Boost if option is set or if previously boosted
          if (options.boosted) {
            this.boostTorrent(torrent.infoHash).catch((e) => {
              console.warn(`[Auto-Boost] Error boosting ${torrent.infoHash}:`, e.message);
            });
          }

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
      this.saveSession();
    });

    torrent.on('ready', () => {
      console.log(`[Torrent Swarm Ready]: ${torrent.name} (${torrent.infoHash})`);
      this.saveSession();
    });

    torrent.on('wire', (wire, addr) => {
      console.log(`[Peer Connected ${torrent.infoHash}]: ${addr} (Total peers: ${torrent.numPeers})`);
    });

    torrent.on('done', () => {
      console.log(`[Torrent 100% Complete]: ${torrent.name} (${torrent.infoHash})`);
      this.saveSession();
    });

    torrent.on('error', (err) => {
      console.error(`[Torrent Error ${torrent.infoHash}]:`, err.message);
    });

    torrent.on('warning', (warn) => {
      console.warn(`[Torrent Warning ${torrent.infoHash}]:`, warn);
    });
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
  pauseTorrent(infoHash) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');

    const key = torrent.infoHash || infoHash;
    const state = this.torrentsState.get(key) || {};
    state.paused = true;
    this.torrentsState.set(key, state);

    // Call WebTorrent pause
    try {
      torrent.pause();
    } catch (e) {}

    // Deselect all pieces to clear active selections pipeline
    if (torrent.pieces && torrent.pieces.length > 0) {
      try {
        torrent.deselect(0, torrent.pieces.length - 1);
      } catch (e) {}
    }

    // Cancel in-flight block requests and set uninterested on all active wires
    if (Array.isArray(torrent.wires)) {
      for (const wire of torrent.wires) {
        try {
          if (Array.isArray(wire.requests)) {
            for (const req of [...wire.requests]) {
              try { wire.cancel(req.piece, req.offset, req.length); } catch (e) {}
            }
          }
          wire.uninterested();
        } catch (e) {}
      }
    }

    this.saveSession();
    return true;
  }

  // Resume torrent
  resumeTorrent(infoHash) {
    const torrent = this.findTorrent(infoHash);
    if (!torrent) throw new Error('Torrent not found');

    const key = torrent.infoHash || infoHash;
    const state = this.torrentsState.get(key) || {};
    state.paused = false;
    this.torrentsState.set(key, state);

    // Re-select pieces for active files
    if (torrent.files && torrent.files.length > 0) {
      for (const file of torrent.files) {
        if (typeof file._selected === 'boolean' ? file._selected : true) {
          try { file.select(); } catch (e) {}
        }
      }
    } else if (torrent.pieces && torrent.pieces.length > 0) {
      try {
        torrent.select(0, torrent.pieces.length - 1, state.sequential ? 1 : 0);
      } catch (e) {}
    }

    try {
      torrent.resume();
    } catch (e) {}

    this.saveSession();
    return true;
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

  // Remove torrent
  removeTorrent(infoHash, deleteFiles = false) {
    return new Promise((resolve, reject) => {
      const torrent = this.findTorrent(infoHash);
      if (!torrent) {
        return reject(new Error('Torrent not found'));
      }

      const key = torrent.infoHash || infoHash;

      // Clean up auxiliary trackers and state
      this.trackerService.cleanupTorrent(key);

      this.client.remove(torrent, { destroyStore: deleteFiles }, (err) => {
        if (err) return reject(err);
        this.torrentsState.delete(key);
        this.saveSession();
        resolve(true);
      });
    });
  }

  // Format summary data for listing
  formatTorrentSummary(torrent) {
    const infoHash = torrent.infoHash || 'retrieving';
    const state = this.torrentsState.get(infoHash) || {};
    let status = 'downloading';
    if (state.paused) {
      status = 'paused';
    } else if (torrent.done) {
      status = 'completed';
    } else if (!torrent.name || (torrent.numPeers === 0 && torrent.progress === 0)) {
      status = 'connecting';
    }

    return {
      infoHash: infoHash,
      name: torrent.name || torrent.displayName || 'Retrieving metadata from swarm...',
      magnetURI: torrent.magnetURI,
      progress: Math.min(1, Math.max(0, torrent.progress || 0)),
      downloadSpeed: state.paused ? 0 : (torrent.downloadSpeed || 0),
      uploadSpeed: state.paused ? 0 : (torrent.uploadSpeed || 0),
      downloaded: torrent.downloaded || 0,
      uploaded: torrent.uploaded || 0,
      length: torrent.length || 0,
      numPeers: torrent.numPeers || 0,
      timeRemaining: state.paused ? Infinity : (torrent.timeRemaining || 0),
      ratio: torrent.ratio || 0,
      status: status,
      paused: state.paused || false,
      sequential: state.sequential || false,
      boosted: state.boosted || false,
      lastBoostedAt: state.lastBoostedAt || null,
      addedAt: state.addedAt || Date.now(),
      filesCount: torrent.files ? torrent.files.length : 0,
      pieceLength: torrent.pieceLength || 0,
      numPieces: torrent.pieces ? torrent.pieces.length : 0
    };
  }

  // Format detailed information including peers, files, piece bitfield, and all active trackers
  formatTorrentDetails(torrent) {
    const summary = this.formatTorrentSummary(torrent);

    // Format files safely
    const files = (torrent.files || []).map((file, idx) => ({
      index: idx,
      name: file.name,
      path: file.path,
      length: file.length,
      downloaded: file.downloaded,
      progress: file.progress,
      selected: typeof file._selected === 'boolean' ? file._selected : true
    }));

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
      } catch (e) {}

      let dlSpeed = 0;
      let ulSpeed = 0;
      try {
        if (typeof wire.downloadSpeed === 'function') dlSpeed = wire.downloadSpeed();
        if (typeof wire.uploadSpeed === 'function') ulSpeed = wire.uploadSpeed();
      } catch (e) {}

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
        amInterested: wire.amInterested || false
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
      trackers
    };
  }

  // Get all torrents summary
  getAllTorrents() {
    return this.client.torrents
      .filter(t => t.infoHash) // Only return torrents with valid parsed infoHash
      .map((t) => this.formatTorrentSummary(t));
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

    for (const t of this.client.torrents) {
      const st = this.torrentsState.get(t.infoHash) || {};
      if (!st.paused && !t.done) {
        anyActive = true;
        activeDownSpeed += (t.downloadSpeed || 0);
        activeUpSpeed += (t.uploadSpeed || 0);
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
      turboStats: this.trackerService ? this.trackerService.stats : { totalBoosts: 0, totalPeersInjected: 0 }
    };
  }
}

export default TorrentManager;
