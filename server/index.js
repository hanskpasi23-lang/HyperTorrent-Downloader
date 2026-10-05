import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import TorrentManager from './torrentManager.js';
import SearchEngine from './searchEngine.js';

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
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve(__dirname, '../public')));

// ----------------------------------------------------
// REST API ROUTES
// ----------------------------------------------------

// Global stats
app.get('/api/status', (req, res) => {
  res.json(manager.getGlobalStats());
});

// List all torrents
app.get('/api/torrents', (req, res) => {
  res.json(manager.getAllTorrents());
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
      autoAddedTorrent = await manager.addTorrent(best.magnetURI);
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
      autoAddedTorrent = await manager.addTorrent(magnets[0].magnetURI);
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
    const summary = await manager.addTorrent(raw.trim());
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

    const summary = await manager.addTorrent(req.file.buffer);
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
    await manager.removeTorrent(req.params.infoHash, deleteFiles);
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
    const file = torrent.files && torrent.files[fileIndex];
    if (!file) {
      return res.status(404).json({ error: 'File index not found' });
    }

    // Prioritize pieces for this file
    file.select();

    const total = file.length;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': file.mime || 'application/octet-stream'
      });

      const stream = file.createReadStream({ start, end });
      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[Stream Error]:', err.message);
      });
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': file.mime || 'application/octet-stream'
      });
      const stream = file.createReadStream();
      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('[Stream Error]:', err.message);
      });
    }
  } catch (err) {
    console.error('Streaming exception:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// REAL-TIME WEBSOCKET BROADCASTER
// ----------------------------------------------------

const clientSubscriptions = new Map(); // ws -> subscribed infoHash

wss.on('connection', (ws) => {
  clientSubscriptions.set(ws, null);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe_details') {
        clientSubscriptions.set(ws, data.infoHash);
        // Immediately send details
        const details = manager.getTorrent(data.infoHash);
        if (details) {
          ws.send(JSON.stringify({ type: 'torrent_details', details }));
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

// Periodic broadcast interval (every 500ms for buttery-smooth telemetry)
setInterval(() => {
  if (wss.clients.size === 0) return;

  const globalStats = manager.getGlobalStats();
  const torrents = manager.getAllTorrents();

  const broadcastPayload = JSON.stringify({
    type: 'tick',
    stats: globalStats,
    torrents: torrents
  });

  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(broadcastPayload);

      // Check if client is subscribed to a specific torrent's deep details
      const subscribedHash = clientSubscriptions.get(client);
      if (subscribedHash) {
        const details = manager.getTorrent(subscribedHash);
        if (details) {
          client.send(JSON.stringify({
            type: 'torrent_details',
            details
          }));
        }
      }
    }
  }
}, 500);

// Start Server
server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`⚡ Torrent Engine & Web Dashboard active!`);
  console.log(`🌐 Web UI: http://localhost:${PORT}`);
  console.log(`📁 Download directory: ${manager.downloadDir}`);
  console.log(`=================================================`);
});
