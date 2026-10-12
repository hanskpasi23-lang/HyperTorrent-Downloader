/**
 * PeerOptimizer — Advanced BitTorrent Swarm Scorer & Choke Eviction Engine
 * 
 * HyperTorrent Performance Engine (Priority 🥇):
 * Continuously evaluates connected peer wires, calculating multi-factor quality scores
 * based on download throughput, unchoke consistency, block latency, and piece availability.
 * Automatically evicts dead, choked, or stalled peers to free up wire slots, triggering
 * WebTorrent's internal connection drain and tracker harvesting to rotate in high-speed seeders.
 */

export class PeerOptimizer {
  constructor(options = {}) {
    this.trackerService = options.trackerService || null;
    this.evaluationIntervalMs = options.evaluationIntervalMs || 15000; // Run every 15s
    this.minSwarmSizeForEviction = options.minSwarmSizeForEviction || 8; // Need at least 8 peers before pruning
    this.peerGracePeriodMs = options.peerGracePeriodMs || 25000; // 25s grace period for fresh connections
    this.maxEvictionRate = options.maxEvictionRate || 0.20; // Evict up to 20% of worst peers per cycle

    // Map: infoHash -> Map(wireKey -> wireMetadata)
    this.wireMetadata = new Map();

    // Global Telemetry
    this.stats = {
      totalEvaluations: 0,
      totalEvicted: 0,
      lastOptimizedAt: null,
      lastEvictedCount: 0
    };

    this.timer = null;
  }

  /**
   * Register a newly connected wire for a torrent
   */
  registerWire(torrent, wire) {
    if (!torrent || !torrent.infoHash || !wire) return;
    const infoHash = torrent.infoHash.toLowerCase();

    if (!this.wireMetadata.has(infoHash)) {
      this.wireMetadata.set(infoHash, new Map());
    }

    const wireMap = this.wireMetadata.get(infoHash);
    const wireKey = this._getWireKey(wire);

    wireMap.set(wireKey, {
      connectedAt: Date.now(),
      lastSeenBytes: wire.downloaded || 0,
      lastProgressAt: Date.now(),
      chokedSince: wire.peerChoking ? Date.now() : null,
      consecutiveStalls: 0,
      score: 50, // Initial neutral score
      label: 'Evaluating'
    });

    // Wire disconnect cleanup
    wire.once('close', () => {
      wireMap.delete(wireKey);
    });
  }

  /**
   * Generate unique identifier for wire
   */
  _getWireKey(wire) {
    return `${wire.remoteAddress || 'unknown'}:${wire.remotePort || 0}`;
  }

  /**
   * Calculate real-time Quality Score (0 - 100) and status label for a wire
   */
  scoreWire(wire, meta, torrent) {
    if (!wire) return { score: 0, label: 'Disconnected' };

    const now = Date.now();
    const ageMs = now - (meta ? meta.connectedAt : now);
    const isNew = ageMs < this.peerGracePeriodMs;

    let dlSpeed = 0;
    try {
      if (typeof wire.downloadSpeed === 'function') {
        dlSpeed = wire.downloadSpeed();
      }
    } catch (e) {}

    const downloadedBytes = wire.downloaded || 0;
    const isChoked = wire.peerChoking !== false;

    // Track choke duration
    if (meta) {
      if (isChoked) {
        if (!meta.chokedSince) meta.chokedSince = now;
      } else {
        meta.chokedSince = null;
      }

      // Track progress
      if (downloadedBytes > meta.lastSeenBytes) {
        meta.lastSeenBytes = downloadedBytes;
        meta.lastProgressAt = now;
        meta.consecutiveStalls = 0;
      } else if (dlSpeed === 0 && !isNew) {
        meta.consecutiveStalls++;
      }
    }

    const chokedDurationSec = meta && meta.chokedSince ? Math.floor((now - meta.chokedSince) / 1000) : 0;
    const idleDurationSec = meta ? Math.floor((now - meta.lastProgressAt) / 1000) : 0;

    // ── Score Components ──

    // 1. Download Speed (0 - 55 points)
    // 500 KB/s or more gives maximum points
    const speedScore = Math.min(55, (dlSpeed / (500 * 1024)) * 55);

    // 2. Data Volume Contributed (0 - 25 points)
    // 10 MB or more gives maximum points
    const volumeScore = Math.min(25, (downloadedBytes / (10 * 1024 * 1024)) * 25);

    // 3. Seeder / Availability Bonus (0 - 20 points)
    let rarityBonus = 0;
    try {
      if (wire.peerPieces) {
        // Complete seeder bonus
        if (torrent && torrent.pieces && wire.peerPieces.length >= torrent.pieces.length) {
          rarityBonus = 15;
        } else {
          rarityBonus = 10;
        }
      }
    } catch (e) {}

    let totalScore = speedScore + volumeScore + rarityBonus;

    // 4. Penalties
    let isStalled = false;

    if (!isNew) {
      // Choke Penalty: Choked for > 25 seconds
      if (isChoked && chokedDurationSec > 25) {
        const chokePenalty = Math.min(50, (chokedDurationSec - 25) * 1.5);
        totalScore -= chokePenalty;
      }

      // Stalled Requests Penalty: We asked for blocks but received nothing for > 15s
      const pendingReqs = (wire.requests && wire.requests.length) || 0;
      if (pendingReqs > 0 && idleDurationSec > 15) {
        totalScore -= 35;
        isStalled = true;
      }

      // Complete Deadlock: 0 bytes ever, choked, connected > 40s
      if (downloadedBytes === 0 && isChoked && ageMs > 40000) {
        totalScore -= 40;
        isStalled = true;
      }
    } else {
      // Grace period baseline
      totalScore = Math.max(45, totalScore);
    }

    // Clamp score to 0 - 100
    totalScore = Math.max(0, Math.min(100, Math.round(totalScore)));

    // Categorize Label
    let label = 'Active Partner';
    if (isNew) {
      label = 'Evaluating';
    } else if (totalScore >= 80) {
      label = 'Elite Seeder';
    } else if (totalScore >= 50) {
      label = 'Active Partner';
    } else if (totalScore >= 25) {
      label = 'Fair';
    } else {
      label = isStalled ? 'Stalled' : 'Choked';
    }

    if (meta) {
      meta.score = totalScore;
      meta.label = label;
    }

    return {
      score: totalScore,
      label,
      dlSpeed,
      downloadedBytes,
      chokedDurationSec,
      isChoked,
      isStalled,
      isNew
    };
  }

  /**
   * Run an optimization and prune pass on a specific active torrent
   * Returns telemetry about the optimization
   */
  optimizeTorrent(torrent) {
    if (!torrent || torrent.destroyed || torrent.paused || torrent.done) {
      return { optimized: false, evictedCount: 0, reason: 'Inactive or complete' };
    }

    const wires = Array.isArray(torrent.wires) ? torrent.wires : [];
    if (wires.length < this.minSwarmSizeForEviction) {
      return {
        optimized: false,
        evictedCount: 0,
        currentPeers: wires.length,
        reason: `Swarm building (${wires.length}/${this.minSwarmSizeForEviction} peers needed)`
      };
    }

    const infoHash = torrent.infoHash.toLowerCase();
    if (!this.wireMetadata.has(infoHash)) {
      this.wireMetadata.set(infoHash, new Map());
    }
    const wireMap = this.wireMetadata.get(infoHash);

    // Score all current wires
    const scoredWires = wires.map(wire => {
      const wireKey = this._getWireKey(wire);
      let meta = wireMap.get(wireKey);
      if (!meta) {
        meta = {
          connectedAt: Date.now() - 10000,
          lastSeenBytes: wire.downloaded || 0,
          lastProgressAt: Date.now(),
          chokedSince: wire.peerChoking ? Date.now() : null,
          consecutiveStalls: 0,
          score: 50,
          label: 'Evaluating'
        };
        wireMap.set(wireKey, meta);
      }
      const evalData = this.scoreWire(wire, meta, torrent);
      return { wire, wireKey, ...evalData };
    });

    // Sort by score ascending (lowest score first = worst performers)
    scoredWires.sort((a, b) => a.score - b.score);

    // Filter eviction candidates:
    // - Must NOT be in grace period
    // - Must have score < 25 (choked for long time, stalled, or 0 bytes transferred)
    // - Must not be actively delivering data (> 10 KB/s)
    const candidates = scoredWires.filter(item => {
      return !item.isNew && item.score < 25 && item.dlSpeed < 10 * 1024;
    });

    // Max evictions allowed in this single cycle
    const maxToEvict = Math.max(1, Math.floor(wires.length * this.maxEvictionRate));
    const toEvict = candidates.slice(0, maxToEvict);

    let evictedCount = 0;

    for (const item of toEvict) {
      try {
        const wire = item.wire;
        // Cancel any pending unfulfilled requests to free pieces for good peers
        if (wire.requests && Array.isArray(wire.requests)) {
          wire.requests = [];
        }

        // Clean up from map
        wireMap.delete(item.wireKey);

        // Evict peer connection
        if (wire.peer) {
          torrent.removePeer(wire.peer);
        } else if (typeof wire.destroy === 'function') {
          wire.destroy();
        }

        evictedCount++;
        this.stats.totalEvicted++;
      } catch (err) {
        // Safe skip on already closed sockets
      }
    }

    this.stats.totalEvaluations++;
    this.stats.lastOptimizedAt = Date.now();
    this.stats.lastEvictedCount = evictedCount;

    if (evictedCount > 0) {
      console.log(`[PeerOptimizer] ⚡ Evicted ${evictedCount} stalled/choked peers from ${torrent.name || infoHash}. Swarm auto-draining fresh connections.`);

      // If we evicted peers and swarm has room, re-harvest fresh tracker seeders
      if (this.trackerService && wires.length - evictedCount < 20) {
        this.trackerService.boostTorrent(torrent).catch(() => {});
      }
    }

    return {
      optimized: true,
      evictedCount,
      totalConnected: wires.length - evictedCount,
      totalEvaluated: wires.length
    };
  }

  /**
   * Decorate peer objects with quality scores and health information for UI
   */
  decoratePeerInfo(wire, torrent) {
    if (!wire) return null;
    const infoHash = torrent?.infoHash?.toLowerCase();
    const wireKey = this._getWireKey(wire);
    const meta = infoHash && this.wireMetadata.has(infoHash)
      ? this.wireMetadata.get(infoHash).get(wireKey)
      : null;

    const evalData = this.scoreWire(wire, meta, torrent);

    return {
      qualityScore: evalData.score,
      healthLabel: evalData.label,
      isStalled: evalData.isStalled,
      chokedDurationSec: evalData.chokedDurationSec
    };
  }

  /**
   * Get global telemetry summary
   */
  getStats() {
    return {
      totalEvaluations: this.stats.totalEvaluations,
      totalEvicted: this.stats.totalEvicted,
      lastOptimizedAt: this.stats.lastOptimizedAt,
      lastEvictedCount: this.stats.lastEvictedCount,
      engineActive: true
    };
  }

  /**
   * Clean up all state for a torrent when removed
   */
  cleanupTorrent(infoHash) {
    if (infoHash) {
      this.wireMetadata.delete(infoHash.toLowerCase());
    }
  }
}

export default PeerOptimizer;
