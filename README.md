# ⚡ HyperTorrent

An ultra high-speed, modern **BitTorrent download engine & Glassmorphic Web Dashboard** built with Node.js, WebSockets, and HTML5 Canvas.

![HyperTorrent](https://img.shields.io/badge/HyperTorrent-Engine_Online-00f2fe?style=for-the-badge&logo=bittorrent)
![Node.js](https://img.shields.io/badge/Node.js-v24+-339933?style=for-the-badge&logo=nodedotjs)
![WebSockets](https://img.shields.io/badge/Telemetry-Real--Time_WebSocket-8a2be2?style=for-the-badge)

---

## 🚀 Key High-Speed Features

- **⚡ Turbo Boost Swarm Acceleration**: Instantly queries 90+ verified live community BitTorrent trackers (UDP, HTTPS, and WebRTC WebSocket) harvested from top tracker repositories. Injects trackers dynamically, forces immediate DHT & Tracker re-announcing, unchokes peers, and multiplies connected seeders by up to 3×–10×.
- **Pipelined Block Transfers**: Requests multiple 16 KiB blocks simultaneously across unchoked peers to saturate bandwidth.
- **Maximized Peer Swarm Discovery**: Combines **UDP Trackers (BEP 15)**, **HTTP/HTTPS Trackers**, **WebRTC WebSocket Trackers**, **DHT (Distributed Hash Table / Kademlia BEP 05)**, **PEX (Peer Exchange BEP 11)**, and **LSD (Local Peer Discovery)**.
- **Automatic NAT Traversal**: UPnP and NAT-PMP port forwarding automatically maps router ports for direct inbound peer connections.
- **In-Flight Media Streaming**: Stream video (`.mp4`, `.mkv`, `.webm`) and audio (`.mp3`, `.flac`) directly inside your browser before the download finishes using HTTP Range requests (`206 Partial Content`).
- **Sequential Download Mode**: Easily toggle sequential piece prioritization for instant media playback.
- **Real-Time Piece Matrix Canvas**: An interactive `<canvas>` rendering every downloaded vs missing piece in real time with hover inspection.
- **Swarm & Peer Inspector**: Track peer IPs, client versions (e.g. qBittorrent, Transmission), download/upload speeds, and choking states.
- **Integrated Swarm Search & Seeder Filter**: Search across indexers directly inside the UI. Results are automatically ranked and filtered by highest seeders to maximize speed.
- **Zero-Click Auto-Add**: Enable "Auto-Add Healthiest Swarm" to automatically grab the #1 seeded swarm and start downloading instantly with zero extra clicks.
- **Webpage Link Sniffer**: Paste any webpage or forum URL to extract, filter, and add all active magnet links.
- **Browser Auto-Catch (Native Handler & Extension)**:
  - Click **Browser Catch** on the header to register HyperTorrent as the default handler for all `magnet:` links in Chrome, Edge, and Firefox.
  - Ready-to-use **Browser Extension** in `extension/` that intercepts magnet clicks across any website and sends them directly to HyperTorrent in the background.

---

## 🖥 Quick Start

### ⚡ Option A: Launch as Native Desktop Application (Electron)
HyperTorrent includes a native Windows desktop client with system tray support, minimize-to-tray background downloading, and OS-level `magnet:` deep-linking.

1. **Run in Desktop Mode**:
   ```bash
   npm run desktop
   ```
2. **Build Standalone Windows Executable (.exe)**:
   ```bash
   npm run build:portable   # Creates a standalone portable .exe in release/
   npm run build:exe        # Creates a full NSIS installer
   ```
   The generated executable will be saved in `release/`. Users can simply double-click `HyperTorrent.exe` to run the client without needing Node.js or terminal commands!

---

### 🌐 Option B: Launch as Web Daemon
```bash
npm start
```
The server will start on port `3000`. Open your browser to `http://localhost:3000`.

---

### 🧩 Option C: (Optional) Install the Browser Extension
1. Open Chrome/Edge/Brave and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** (top right corner).
3. Click **Load unpacked** and select the `extension/` folder inside this project.
4. Now, whenever you browse any website, clicking a magnet link will automatically send it to HyperTorrent!

---

## 📡 REST & WebSocket API Reference

### REST Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/status` | Global engine statistics (speed, ratio, total torrents) |
| `GET` | `/api/torrents` | List of all active torrents |
| `GET` | `/api/torrents/:infoHash` | Detailed torrent information (pieces, peers, files, trackers) |
| `GET` | `/api/search?q=...&autoAdd=true/false` | Search swarms, filter by highest seeds, optional auto-add |
| `POST` | `/api/sniff-page` | Scrape & extract magnet links from any web URL |
| `POST` | `/api/torrents/magnet` | Add a torrent using a magnet URI |
| `POST` | `/api/torrents/upload` | Upload a `.torrent` file (`multipart/form-data`) |
| `POST` | `/api/torrents/:infoHash/pause` | Pause an active torrent |
| `POST` | `/api/torrents/:infoHash/resume` | Resume a paused torrent |
| `POST` | `/api/torrents/:infoHash/boost` | ⚡ Turbo Boost single torrent (Inject live trackers & re-announce) |
| `POST` | `/api/torrents/boost-all` | ⚡ Turbo Boost all active torrents |
| `GET` | `/api/trackers/live` | Retrieve live harvested trackers pool & stats |
| `POST` | `/api/torrents/:infoHash/sequential` | Toggle sequential piece downloading |
| `POST` | `/api/torrents/:infoHash/files/:fileIndex/priority` | Select or skip an individual file |
| `DELETE` | `/api/torrents/:infoHash?deleteFiles=true/false` | Remove torrent with optional file deletion |
| `GET` | `/api/stream/:infoHash/:fileIndex` | Stream media file with HTTP Range support |

### Real-Time WebSocket (`/ws`)
- **Broadcast**: Telemetry packet emitted every `500ms` with instantaneous download/upload speeds, active counts, and torrent progress.
- **Subscriptions**: Send `{"type": "subscribe_details", "infoHash": "..."}` to receive high-frequency piece bitfield and swarm updates for the inspector drawer.

---

## 📂 Project Structure

```
Torrent downloader/
├── downloads/                # Downloaded files destination
├── public/                   # Frontend Dashboard
│   ├── css/
│   │   └── style.css         # Cyberpunk / Glassmorphic design system
│   ├── js/
│   │   └── app.js           # WebSocket client, canvas matrix, and controls
│   └── index.html            # Dashboard layout and modals
├── server/                   # Backend Daemon
│   ├── index.js              # Express REST & WebSocket server
│   └── torrentManager.js     # BitTorrent engine, swarm manager, and session cache
├── package.json              # Project configuration and dependencies
├── session.json              # Persistent state across restarts
└── README.md                 # Project documentation
```
