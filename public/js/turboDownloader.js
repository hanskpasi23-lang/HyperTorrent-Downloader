/**
 * ============================================================================
 * ⚡ HyperTorrent Turbo Downloader Engine (IDM-Style Multi-Stream Pipeline)
 * ============================================================================
 * Features:
 * - Dynamic file segmentation & multipart HTTP Range requests (RFC 7233)
 * - 4 / 8 / 16 parallel concurrent TCP streams
 * - Dynamic work-stealing algorithm (re-splits lagging threads like IDM)
 * - Zero-RAM direct disk streaming via File System Access API (showSaveFilePicker)
 * - Mobile resilience: Screen Wake Lock API prevents iOS/Android tab freeze
 * - Fallback in-memory / Blob stream pipeline for mobile & non-Chromium browsers
 * - Rolling window throughput speedometer & accurate ETA estimator
 * ============================================================================
 */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TurboDownloader = factory();
  }
})(typeof self !== 'undefined' ? self : this, function() {

class TurboDownloader {
  constructor(options = {}) {
    this.infoHash = options.infoHash || null;
    this.fileIndex = options.fileIndex !== undefined ? options.fileIndex : null;
    this.filename = options.filename || 'download.bin';
    this.fileLength = options.fileLength || 0;
    this.concurrency = options.concurrency || 8;
    this.downloadUrl = options.downloadUrl || null;

    this.status = 'idle'; // 'idle' | 'preparing' | 'downloading' | 'paused' | 'completed' | 'cancelled' | 'error'
    this.errorMessage = null;

    // Concurrency & thread state
    this.threads = [];
    this.totalDownloaded = 0;
    this.speed = 0;
    this.peakSpeed = 0;
    this.eta = 0;
    this.startTime = null;

    // Disk I/O & Storage targets
    this.fileHandle = null;
    this.writable = null;
    this.writeQueuePromise = Promise.resolve();
    this.storageMode = 'memory'; // 'filesystem' | 'memory' | 'opfs'
    this.memoryChunks = []; // Fallback buffer

    // Mobile screen lock
    this.wakeLockSentinel = null;

    // Telemetry ticker timer
    this.tickerInterval = null;
    this.speedSamples = [];

    // Global cancellation controller
    this.abortController = null;

    // Event hooks
    this.onProgress = options.onProgress || null;
    this.onThreadUpdate = options.onThreadUpdate || null;
    this.onStateChange = options.onStateChange || null;
    this.onComplete = options.onComplete || null;
    this.onError = options.onError || null;
  }

  // --------------------------------------------------------------------------
  // Static Platform Capabilities
  // --------------------------------------------------------------------------
  static isFileSystemAccessSupported() {
    return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
  }

  static isWakeLockSupported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  static isMobile() {
    if (typeof navigator === 'undefined') return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints && navigator.maxTouchPoints > 2);
  }

  // --------------------------------------------------------------------------
  // Initialization & Preparation
  // --------------------------------------------------------------------------
  async prepare(filePickerHandle = null) {
    this.setStatus('preparing');

    // Acquire Wake Lock on mobile devices so screen does not dim
    await this.acquireWakeLock();

    // Check if we can stream directly to disk (Zero-RAM mode)
    if (filePickerHandle) {
      this.fileHandle = filePickerHandle;
      this.writable = await this.fileHandle.createWritable({ keepExistingData: true });
      this.storageMode = 'filesystem';
    } else if (TurboDownloader.isFileSystemAccessSupported() && !TurboDownloader.isMobile()) {
      try {
        const ext = this.filename.includes('.') ? this.filename.split('.').pop() : '';
        const options = {
          suggestedName: this.filename
        };
        if (ext) {
          options.types = [{
            description: `${ext.toUpperCase()} File`,
            accept: { [`application/${ext}`]: [`.${ext}`] }
          }];
        }
        this.fileHandle = await window.showSaveFilePicker(options);
        this.writable = await this.fileHandle.createWritable({ keepExistingData: true });
        this.storageMode = 'filesystem';
      } catch (err) {
        if (err.name === 'AbortError') {
          this.setStatus('cancelled');
          throw new Error('File save cancelled by user.');
        }
        console.warn('[TurboDownloader] File System Access denied, falling back to memory/blob:', err);
        this.storageMode = 'memory';
      }
    } else {
      this.storageMode = 'memory';
    }

    // Initialize segments across the configured number of threads
    this.initSegments();
    return true;
  }

  initSegments() {
    this.threads = [];
    const total = this.fileLength;
    const count = Math.min(this.concurrency, Math.max(1, Math.floor(total / (256 * 1024)))); // At least 256KB per thread

    if (count <= 1 || total <= 0) {
      // Single thread
      this.threads.push({
        id: 0,
        start: 0,
        end: total - 1,
        current: 0,
        downloaded: 0,
        status: 'pending',
        speed: 0,
        lastBytes: 0,
        lastTime: Date.now()
      });
      return;
    }

    const segSize = Math.floor(total / count);
    for (let i = 0; i < count; i++) {
      const start = i * segSize;
      const end = (i === count - 1) ? total - 1 : ((i + 1) * segSize - 1);
      this.threads.push({
        id: i,
        start,
        end,
        current: start,
        downloaded: 0,
        status: 'pending',
        speed: 0,
        lastBytes: 0,
        lastTime: Date.now()
      });
    }
  }

  // --------------------------------------------------------------------------
  // Download Execution & Concurrency
  // --------------------------------------------------------------------------
  async start() {
    if (this.status === 'downloading') return;

    if (this.threads.length === 0) {
      await this.prepare();
    }

    this.setStatus('downloading');
    this.abortController = new AbortController();
    this.startTime = Date.now();
    this.startTicker();

    try {
      const threadPromises = this.threads.map(thread => this.runThread(thread));
      await Promise.all(threadPromises);

      // Verify completion
      if (this.status === 'downloading') {
        await this.finalize();
      }
    } catch (err) {
      if (err.name === 'AbortError' || this.status === 'paused' || this.status === 'cancelled') {
        return;
      }
      console.error('[TurboDownloader] Download execution error:', err);
      this.errorMessage = err.message || 'Unknown network error';
      this.setStatus('error');
      if (this.onError) this.onError(err);
    }
  }

  async runThread(thread) {
    while (this.status === 'downloading' && thread.current <= thread.end) {
      const rangeStart = thread.current;
      const rangeEnd = thread.end;

      if (rangeStart > rangeEnd) {
        thread.status = 'completed';
        this.emitThreadUpdate();
        break;
      }

      thread.status = 'active';
      this.emitThreadUpdate();

      try {
        const response = await fetch(this.downloadUrl, {
          headers: {
            'Range': `bytes=${rangeStart}-${rangeEnd}`
          },
          signal: this.abortController.signal
        });

        if (response.status !== 206 && response.status !== 200) {
          throw new Error(`Server returned HTTP ${response.status} for range ${rangeStart}-${rangeEnd}`);
        }

        const reader = response.body.getReader();

        while (this.status === 'downloading') {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = value;
          const writeOffset = thread.current;

          // Write chunk to destination
          await this.writeChunk(writeOffset, chunk);

          // Update thread telemetry
          thread.current += chunk.length;
          thread.downloaded += chunk.length;
          this.totalDownloaded += chunk.length;

          // Check if thread reached its allocated boundary
          if (thread.current > thread.end) {
            break;
          }
        }

        if (thread.current > thread.end) {
          thread.status = 'completed';
          this.emitThreadUpdate();

          // ⚡ Dynamic Segment Work-Stealing (IDM Algorithm)
          // Find lagging thread and take over half of its remaining work
          const stolen = this.tryWorkSteal(thread);
          if (!stolen) {
            break; // No more work available
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          thread.status = this.status === 'paused' ? 'paused' : 'cancelled';
          return;
        }
        console.warn(`[TurboDownloader] Thread #${thread.id} stream error:`, err.message);
        thread.status = 'retrying';
        this.emitThreadUpdate();
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (thread.current > thread.end) {
      thread.status = 'completed';
    }
    this.emitThreadUpdate();
  }

  /**
   * ⚡ Dynamic Segment Work-Stealing
   * If a thread finishes its segment early, find the active thread with the largest
   * unfinished byte range, split that remaining range in half, and assign the second half
   * to this free thread!
   */
  tryWorkSteal(freeThread) {
    if (this.status !== 'downloading') return false;

    const MIN_SPLIT_BYTES = 2 * 1024 * 1024; // 2 MB minimum to justify a new TCP connection

    let bestTarget = null;
    let maxRemaining = 0;

    for (const t of this.threads) {
      if (t.id === freeThread.id) continue;
      if (t.status === 'active' || t.status === 'pending') {
        const remaining = t.end - t.current;
        if (remaining > maxRemaining) {
          maxRemaining = remaining;
          bestTarget = t;
        }
      }
    }

    if (bestTarget && maxRemaining >= MIN_SPLIT_BYTES) {
      // Split the remainder
      const mid = bestTarget.current + Math.floor(maxRemaining / 2);
      const oldEnd = bestTarget.end;

      // Adjust target's end boundary
      bestTarget.end = mid;

      // Assign new range to free thread
      freeThread.start = mid + 1;
      freeThread.end = oldEnd;
      freeThread.current = mid + 1;
      freeThread.status = 'active';

      console.log(`[TurboDownloader] Work-stealing: Thread #${freeThread.id} grabbed ${((oldEnd - mid) / (1024*1024)).toFixed(1)} MB from Thread #${bestTarget.id}`);
      this.emitThreadUpdate();
      return true;
    }

    return false;
  }

  // --------------------------------------------------------------------------
  // Disk Writing Pipeline (Zero-RAM & Fallbacks)
  // --------------------------------------------------------------------------
  async writeChunk(offset, buffer) {
    if (this.storageMode === 'filesystem' && this.writable) {
      // Enqueue sequential seek & write into Promise chain to eliminate race conditions
      this.writeQueuePromise = this.writeQueuePromise.then(async () => {
        try {
          await this.writable.seek(offset);
          await this.writable.write(buffer);
        } catch (e) {
          console.error('[TurboDownloader] Disk write stream error:', e);
          throw e;
        }
      });
      return this.writeQueuePromise;
    } else {
      // Memory / Blob mode
      this.memoryChunks.push({ offset, buffer });
    }
  }

  async finalize() {
    this.setStatus('finishing');
    this.stopTicker();

    if (this.storageMode === 'filesystem' && this.writable) {
      // Ensure all queued writes flush to physical storage
      await this.writeQueuePromise;
      await this.writable.close();
      this.writable = null;
    } else if (this.storageMode === 'memory') {
      // Sort memory chunks by offset and build download Blob
      this.memoryChunks.sort((a, b) => a.offset - b.offset);
      const blobParts = this.memoryChunks.map(c => c.buffer);
      const blob = new Blob(blobParts, { type: 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);

      // Trigger automatic save to device
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = this.filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      }, 5000);
      this.memoryChunks = [];
    }

    this.releaseWakeLock();
    this.setStatus('completed');

    if (this.onComplete) {
      this.onComplete({
        filename: this.filename,
        totalBytes: this.fileLength,
        peakSpeed: this.peakSpeed,
        storageMode: this.storageMode
      });
    }
  }

  // --------------------------------------------------------------------------
  // Controls: Pause, Resume, Cancel
  // --------------------------------------------------------------------------
  pause() {
    if (this.status !== 'downloading') return;
    this.setStatus('paused');
    this.stopTicker();
    if (this.abortController) {
      this.abortController.abort();
    }
    this.releaseWakeLock();
  }

  async resume() {
    if (this.status !== 'paused') return;
    await this.start();
  }

  async cancel() {
    this.setStatus('cancelled');
    this.stopTicker();
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.writable) {
      try {
        await this.writable.abort();
      } catch (e) {}
      this.writable = null;
    }
    this.memoryChunks = [];
    this.releaseWakeLock();
  }

  // --------------------------------------------------------------------------
  // Screen Wake Lock API (Mobile Screen Sleep Prevention)
  // --------------------------------------------------------------------------
  async acquireWakeLock() {
    if (TurboDownloader.isWakeLockSupported()) {
      try {
        this.wakeLockSentinel = await navigator.wakeLock.request('screen');
        console.log('[TurboDownloader] Screen Wake Lock acquired (Mobile Sleep Protected)');
        this.wakeLockSentinel.addEventListener('release', () => {
          this.wakeLockSentinel = null;
        });

        if (!this.visibilityHandler && typeof document !== 'undefined') {
          this.visibilityHandler = async () => {
            if (document.visibilityState === 'visible' && this.status === 'downloading') {
              try {
                this.wakeLockSentinel = await navigator.wakeLock.request('screen');
                console.log('[TurboDownloader] Screen Wake Lock re-acquired on tab visible');
              } catch (e) {}
            }
          };
          document.addEventListener('visibilitychange', this.visibilityHandler);
        }
      } catch (err) {
        console.warn('[TurboDownloader] Could not acquire Wake Lock:', err.message);
      }
    }
  }

  releaseWakeLock() {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.wakeLockSentinel) {
      try {
        this.wakeLockSentinel.release();
        this.wakeLockSentinel = null;
      } catch (e) {}
    }
  }

  // --------------------------------------------------------------------------
  // Telemetry & Speed Calculations
  // --------------------------------------------------------------------------
  startTicker() {
    this.stopTicker();
    let lastGlobalBytes = this.totalDownloaded;
    let lastTickTime = Date.now();

    this.tickerInterval = setInterval(() => {
      const now = Date.now();
      const elapsedSec = (now - lastTickTime) / 1000;
      if (elapsedSec <= 0) return;

      const bytesDiff = this.totalDownloaded - lastGlobalBytes;
      const currentSpeed = bytesDiff / elapsedSec;

      // Rolling average speed
      this.speedSamples.push(currentSpeed);
      if (this.speedSamples.length > 5) this.speedSamples.shift();
      this.speed = this.speedSamples.reduce((a, b) => a + b, 0) / this.speedSamples.length;

      if (this.speed > this.peakSpeed) {
        this.peakSpeed = this.speed;
      }

      // Calculate ETA
      const remainingBytes = Math.max(0, this.fileLength - this.totalDownloaded);
      this.eta = this.speed > 0 ? Math.round(remainingBytes / this.speed) : 0;

      // Update individual thread speeds
      for (const t of this.threads) {
        const tElapsed = (now - t.lastTime) / 1000;
        if (tElapsed > 0) {
          const tDiff = t.downloaded - t.lastBytes;
          t.speed = tDiff / tElapsed;
          t.lastBytes = t.downloaded;
          t.lastTime = now;
        }
      }

      lastGlobalBytes = this.totalDownloaded;
      lastTickTime = now;

      this.emitProgress();
      this.emitThreadUpdate();
    }, 400);
  }

  stopTicker() {
    if (this.tickerInterval) {
      clearInterval(this.tickerInterval);
      this.tickerInterval = null;
    }
  }

  setStatus(newStatus) {
    this.status = newStatus;
    if (this.onStateChange) {
      this.onStateChange(this.status);
    }
  }

  emitProgress() {
    if (this.onProgress) {
      const percent = this.fileLength > 0 ? Math.min(100, (this.totalDownloaded / this.fileLength) * 100) : 0;
      this.onProgress({
        percent,
        downloaded: this.totalDownloaded,
        total: this.fileLength,
        speed: this.speed,
        peakSpeed: this.peakSpeed,
        eta: this.eta,
        status: this.status
      });
    }
  }

  emitThreadUpdate() {
    if (this.onThreadUpdate) {
      this.onThreadUpdate(this.threads);
    }
  }
}

  return TurboDownloader;
});
