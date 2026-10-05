import TrackerClient from 'bittorrent-tracker';

// High-speed fallback public trackers (UDP, HTTPS, and WebRTC WebSocket)
export const DEFAULT_TURBO_TRACKERS = [
  // High-Capacity UDP Tier-1 Trackers
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.dump.cl:6969/announce',
  'udp://tracker.tryhackx.org:6969/announce',
  'udp://ipv4.tracker.harry.lu:80/announce',
  'udp://tracker.altrosky.nl:6969/announce',
  'udp://tracker.srv00.com:6969/announce',
  'udp://retracker.lanta-net.ru:2710/announce',
  'udp://valakas.rollo.dnsabr.com:2710/announce',
  'udp://opentor.net:6969/announce',
  'udp://tracker.pomf.se:80/announce',
  'udp://btracker.top:6969/announce',
  'udp://tracker.filemail.com:6969/announce',
  'udp://tracker.army:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://bt1.archive.org:6969/announce',
  'udp://bt2.archive.org:6969/announce',

  // High-Capacity HTTP/HTTPS Trackers
  'https://tracker.tamersunion.org:443/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://tracker.bt4g.com:2095/announce',
  'https://tracker.nanoha.org:443/announce',
  'https://tracker.lilithraws.org:443/announce',

  // WebSocket / WebRTC Hybrid Trackers (Enables browser WebTorrent seeders)
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce'
];

export class TrackerService {
  constructor() {
    this.cachedTrackers = [...DEFAULT_TURBO_TRACKERS];
    this.lastFetched = 0;
    this.cacheTTL = 12 * 60 * 60 * 1000; // 12 hours
    this.activeTurboTrackers = new Map(); // infoHash -> TrackerClient instance
    this.stats = {
      totalBoosts: 0,
      totalTrackersDiscovered: 0,
      totalPeersInjected: 0
    };

    // Pre-fetch live trackers on boot in the background
    this.fetchLiveTrackers().catch((err) => {
      console.warn('[TrackerService] Initial live tracker fetch notice:', err.message);
    });
  }

  /**
   * Fetch the latest live, active public trackers from trusted community repositories
   */
  async fetchLiveTrackers(force = false) {
    const now = Date.now();
    if (!force && this.cachedTrackers.length > 0 && (now - this.lastFetched < this.cacheTTL)) {
      return this.cachedTrackers;
    }

    console.log('[TrackerService] 🔄 Fetching live BitTorrent community tracker lists...');
    const urls = [
      'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt',
      'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt'
    ];

    const fetchedList = [];

    await Promise.allSettled(
      urls.map(async (url) => {
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'HyperTorrent/1.0 (+https://github.com)' },
            signal: AbortSignal.timeout(6000)
          });
          if (res.ok) {
            const text = await res.text();
            const lines = text
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0 && !line.startsWith('#') && (line.startsWith('udp://') || line.startsWith('http://') || line.startsWith('https://') || line.startsWith('wss://')));
            fetchedList.push(...lines);
          }
        } catch (e) {
          console.warn(`[TrackerService] Mirror unreachable (${url}):`, e.message);
        }
      })
    );

    // Merge with defaults, clean trailing slashes, and deduplicate
    const merged = new Set([
      ...DEFAULT_TURBO_TRACKERS,
      ...fetchedList
    ].map(tr => tr.endsWith('/') ? tr.slice(0, -1) : tr));

    this.cachedTrackers = Array.from(merged);
    this.lastFetched = Date.now();
    console.log(`[TrackerService] ✅ Live tracker harvest ready: ${this.cachedTrackers.length} active verified trackers.`);
    return this.cachedTrackers;
  }

  /**
   * Inject verified trackers, force DHT re-announce, and pump new peers into a torrent
   * @param {object} torrent WebTorrent instance
   * @returns {Promise<object>} Telemetry about the boost operation
   */
  async boostTorrent(torrent) {
    if (!torrent || !torrent.infoHash) {
      throw new Error('Valid torrent instance with infoHash is required to boost');
    }

    const infoHash = torrent.infoHash.toLowerCase();
    const liveTrackers = await this.fetchLiveTrackers();

    // Collect currently known trackers on the torrent
    const existingTrackers = new Set();
    if (Array.isArray(torrent.announce)) {
      torrent.announce.forEach(tr => existingTrackers.add(tr.endsWith('/') ? tr.slice(0, -1) : tr));
    }
    if (torrent.discovery?.tracker?._trackers) {
      torrent.discovery.tracker._trackers.forEach(tr => {
        if (tr.announceUrl) existingTrackers.add(tr.announceUrl.endsWith('/') ? tr.announceUrl.slice(0, -1) : tr.announceUrl);
      });
    }

    // Filter to new trackers only
    const newTrackers = liveTrackers.filter(tr => !existingTrackers.has(tr));

    // Update torrent announcement arrays so internal references know about them
    const combinedTrackers = Array.from(new Set([...existingTrackers, ...liveTrackers]));
    torrent.announce = combinedTrackers;
    if (torrent.discovery) {
      torrent.discovery._announce = combinedTrackers;
    }

    let newlyInjectedPeers = 0;

    // Clean up any previous auxiliary tracker client for this torrent
    this.cleanupTorrent(infoHash);

    // If we have trackers to announce, launch an auxiliary TrackerClient to query them in parallel
    if (newTrackers.length > 0 && torrent.client) {
      const port = torrent.client.torrentPort || 6881;
      const peerId = torrent.client.peerId;

      try {
        const auxTracker = new TrackerClient({
          peerId: peerId,
          infoHash: infoHash,
          port: port,
          announce: newTrackers
        });

        auxTracker.on('peer', (peer) => {
          try {
            if (torrent.destroyed) {
              auxTracker.destroy();
              return;
            }
            newlyInjectedPeers++;
            this.stats.totalPeersInjected++;
            torrent.addPeer(peer, 'tracker');
          } catch (e) {
            // Ignore duplicate/invalid wire errors
          }
        });

        auxTracker.on('warning', () => {});
        auxTracker.on('error', () => {});

        // Start announcing to the newly injected trackers
        auxTracker.start();
        this.activeTurboTrackers.set(infoHash, auxTracker);
      } catch (err) {
        console.warn(`[TrackerService] Could not spawn auxiliary tracker for ${infoHash}:`, err.message);
      }
    }

    // Force DHT re-announce to poll the distributed hash table for fresh seeders
    if (torrent.discovery && typeof torrent.discovery._dhtAnnounce === 'function') {
      try {
        torrent.discovery._dhtAnnounce();
      } catch (e) {}
    }

    // Force update on existing tracker client
    if (torrent.discovery?.tracker && typeof torrent.discovery.tracker.update === 'function') {
      try {
        torrent.discovery.tracker.update();
      } catch (e) {}
    }

    // Express interest across all connected wires to stimulate unchoking
    if (Array.isArray(torrent.wires)) {
      for (const wire of torrent.wires) {
        try {
          if (typeof wire.interested === 'function') wire.interested();
        } catch (e) {}
      }
    }

    this.stats.totalBoosts++;
    this.stats.totalTrackersDiscovered = this.cachedTrackers.length;

    console.log(`[TrackerService] ⚡ TURBO BOOST ACTIVATED for ${torrent.name || infoHash}: Injected ${newTrackers.length} new trackers (Total: ${combinedTrackers.length})`);

    return {
      success: true,
      infoHash: infoHash,
      newTrackersAdded: newTrackers.length,
      totalTrackers: combinedTrackers.length,
      timestamp: Date.now()
    };
  }

  /**
   * Cleanup any active auxiliary trackers for a torrent
   */
  cleanupTorrent(infoHash) {
    if (!infoHash) return;
    const cleanHash = infoHash.toLowerCase();
    const existing = this.activeTurboTrackers.get(cleanHash);
    if (existing) {
      try {
        existing.destroy();
      } catch (e) {}
      this.activeTurboTrackers.delete(cleanHash);
    }
  }

  /**
   * Cleanup all tracker clients on engine shutdown
   */
  destroyAll() {
    for (const [hash, tracker] of this.activeTurboTrackers.entries()) {
      try {
        tracker.destroy();
      } catch (e) {}
    }
    this.activeTurboTrackers.clear();
  }
}

export default TrackerService;
