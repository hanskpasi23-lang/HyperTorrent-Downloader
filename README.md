# ⚡ HyperTorrent

<p align="center">
  <strong>Ultra High-Speed BitTorrent Download Engine, Cloud Seedbox & Cyberpunk Web Dashboard</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/HyperTorrent-Engine_Online-00f2fe?style=for-the-badge&logo=bittorrent" alt="Engine Online" />
  <img src="https://img.shields.io/badge/Node.js-v20+-339933?style=for-the-badge&logo=nodedotjs" alt="Node.js" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ed?style=for-the-badge&logo=docker" alt="Docker" />
  <img src="https://img.shields.io/badge/Telemetry-Real--Time_WebSocket-8a2be2?style=for-the-badge" alt="WebSocket" />
  <img src="https://img.shields.io/badge/License-ISC-ff007f?style=for-the-badge" alt="License" />
</p>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
  - [⚡ Swarm Acceleration & Turbo Boost](#-swarm-acceleration--turbo-boost)
  - [🚀 Cloud Seedbox & Direct Download (Seedr-Style)](#-cloud-seedbox--direct-download-seedr-style)
  - [🔐 Multi-User Authentication & Role Quotas](#-multi-user-authentication--role-quotas)
  - [🛡️ VPS Memory Guard, Concurrency Queue & Disk Auto-Cleanup](#️-vps-memory-guard-concurrency-queue--disk-auto-cleanup)
  - [🔒 SOCKS5 / HTTP Proxy Routing](#-socks5--http-proxy-routing)
  - [🔍 Search Indexer & Webpage Sniffer](#-search-indexer--webpage-sniffer)
  - [🧩 Browser Auto-Catch Extension](#-browser-auto-catch-extension)
  - [🎨 Glassmorphic Cyberpunk Web Dashboard](#-glassmorphic-cyberpunk-web-dashboard)
- [System Architecture & Project Layout](#-system-architecture--project-layout)
- [Quick Start & Deployment](#-quick-start--deployment)
  - [Option A: 1-Click VPS Deployment (Recommended)](#option-a-1-click-vps-deployment-recommended)
  - [Option B: Manual Docker Compose](#option-b-manual-docker-compose)
  - [Option C: Native Node.js Deployment](#option-c-native-nodejs-deployment)
  - [Option D: Browser Extension Setup](#option-d-browser-extension-setup)
- [Configuration & Environment Variables](#-configuration--environment-variables)
  - [Environment Variables](#environment-variables)
  - [Security & Authentication Config](#security--authentication-config)
  - [Google OAuth 2.0 Setup](#google-oauth-20-setup)
  - [Proxy Configuration](#proxy-configuration)
- [API Reference](#-api-reference)
  - [Authentication & Security Endpoints](#authentication--security-endpoints)
  - [User Administration & Quotas](#user-administration--quotas)
  - [Torrent Lifecycle & Acceleration](#torrent-lifecycle--acceleration)
  - [Cloud Seedbox Transfers & Streaming](#cloud-seedbox-transfers--streaming)
  - [Search, Sniffer & Trackers](#search-sniffer--trackers)
  - [Proxy, Queue & Disk Maintenance](#proxy-queue--disk-maintenance)
  - [Real-Time WebSocket Protocol (`/ws`)](#real-time-websocket-protocol-ws)
- [Production Hardening & Reverse Proxy](#-production-hardening--reverse-proxy)
- [License](#-license)

---

## 🌟 Overview

**HyperTorrent** is a modern, high-performance BitTorrent download engine, private cloud seedbox daemon, and real-time web dashboard.

Designed for self-hosters and power users, HyperTorrent acts as your private, 24/7 **Seedr / Real-Debrid** alternative on any VPS or home server. It downloads swarms at datacenter speeds (1–10 Gbps) and lets you stream media instantly or pull finished files straight to your local PC via multi-threaded HTTP/HTTPS downloads (compatible with IDM, aria2, and Free Download Manager).

---

## 🚀 Key Features

### ⚡ Swarm Acceleration & Turbo Boost
- **Turbo Boost Swarm Ingestion**: Instantly queries and injects 90+ verified live community BitTorrent trackers (UDP, HTTPS, and WebRTC WebSocket) harvested from tier-1 tracker lists.
- **Automated Re-Announcing**: Forces DHT (Kademlia BEP 05), PEX (Peer Exchange BEP 11), LSD (Local Peer Discovery), and BEP 15 tracker re-announcements to multiply connected seeders by 3×–10×.
- **Autonomous PeerOptimizer**: Continuously scores peer connections based on transfer rates, unchoking consistency, piece availability, and block latency. Stalled or choked peers are automatically evicted to rotate in high-speed seeders.
- **Pipelined Block Transfers**: Requests multiple 16 KiB blocks simultaneously across unchoked peers to maximize bandwidth saturation.
- **Automatic NAT Traversal**: UPnP and NAT-PMP port mapping for direct inbound peer discovery.

### 🚀 Cloud Seedbox & Direct Download (Seedr-Style)
- **Direct High-Speed HTTP/HTTPS Download**: Download completed files straight from your VPS to your local PC with multi-threaded download managers (Internet Download Manager, aria2, FDM, browser).
- **⚡ In-Browser Turbo Downloader**: Built-in client-side multi-stream pipeline with:
  - 4 / 8 / 16 parallel concurrent TCP streams using RFC 7233 HTTP Range requests.
  - Dynamic work-stealing algorithm that re-splits lagging threads (IDM-style).
  - Zero-RAM direct disk streaming via the browser's File System Access API (`showSaveFilePicker`).
  - Mobile resilience with Screen Wake Lock API to prevent iOS and Android tab sleeps.
- **One-Click "Download All as ZIP"**: Generates and streams full torrent archives on-the-fly (`store: true`, `forceZip64: true`) without pre-compressing to disk or buffering in RAM.
- **In-Flight Media Streaming**: Stream video (`.mp4`, `.mkv`, `.webm`, `.avi`) and audio (`.mp3`, `.flac`, `.wav`) directly in the browser while downloading using HTTP 206 Partial Content range requests.
- **Sequential Downloading**: Easily toggle sequential piece prioritization for instant zero-wait media playback.
- **Per-File Selection**: Pick specific files to download or skip within multi-file releases.

### 🔐 Multi-User Authentication & Role Quotas
- **Dual Authentication**: Master Password login (PBKDF2 / SHA-512 with unique salt) + 1-Click Google OAuth 2.0 Sign-In.
- **Role-Based Access Control (RBAC)**:
  - **Admin**: Full access to global telemetry, disk management, user management, queue tuning, and proxy settings.
  - **User**: Isolated workspace where users only see and manage their own torrents.
- **Granular User Quotas**: Enforce limits per user for max active torrents, max total storage bytes, and max single torrent file size.
- **Domain & Email Whitelists**: Restrict access to designated emails or entire company/school domains (e.g. `@gmail.com`, `@mycompany.com`).
- **API Key Authentication**: Issue persistent API keys for headless automation, scripts, and the browser extension.
- **DDoS & Brute Force Rate Limiting**: Built-in tiered rate limiters protecting authentication, torrent submissions, and search endpoints.

### 🛡️ VPS Memory Guard, Concurrency Queue & Disk Auto-Cleanup
- **Concurrency Queue**: Set maximum active downloads to prevent CPU and network starvation on low-spec VPS hosts.
- **Memory Watchdog**: Built-in V8 heap monitoring and garbage collector hooks (`--expose-gc`) prevent out-of-memory (OOM) crashes on small VPS instances.
- **Auto-Pause on Completion**: Automatically pauses finished torrents to save upload bandwidth and RAM.
- **Disk Telemetry & Auto-Cleanup**: Monitors host SSD storage space in real time. Automatically prunes old completed torrents once they exceed a configured retention period.
- **Path Traversal Protection**: Validates and confines all disk operations to the configured download directory.

### 🔒 SOCKS5 / HTTP Proxy Routing
- **DPI & ISP Throttle Bypass**: Route BitTorrent peer connections and tracker announcements through external SOCKS5, HTTP, or HTTPS proxies.
- **Live Connection Tester**: Test proxy connectivity and latency directly from the Admin settings dashboard.
- **Persistent State**: Proxy configuration is saved to disk and automatically restored across server reboots.

### 🔍 Search Indexer & Webpage Sniffer
- **Integrated Swarm Search**: Search public torrent indexers directly within the web dashboard.
- **Health-Ranked Seeder Filter**: Results are automatically prioritized and ranked by highest seeders.
- **Zero-Click Auto-Add**: Automatically picks and starts downloading the healthiest swarm with a single action.
- **Webpage Link Sniffer**: Paste any web page or forum URL to extract, validate, and queue all detected magnet links.

### 🧩 Browser Auto-Catch Extension
- **Chrome / Edge / Brave Ready**: Manifest V3 browser extension located in `extension/`.
- **Background Intercept**: Catches magnet link clicks across any website and dispatches them straight to your remote seedbox.
- **Remote Server Sync**: Connects to your remote HyperTorrent instance with server URL and API key.

### 🎨 Glassmorphic Cyberpunk Web Dashboard
- **Real-Time Piece Matrix Canvas**: Interactive HTML5 `<canvas>` rendering every downloaded vs missing piece in real time with hover inspection.
- **Swarm & Peer Inspector**: Live drawer displaying peer IPs, client software (qBittorrent, Transmission, libtorrent), flags, download/upload rates, and choking status.
- **Live WebSocket Telemetry**: Instantaneous upload/download speedometers and progress updates pushed every 1,000ms.

---

## 📂 System Architecture & Project Layout

```
HyperTorrent/
├── downloads/                  # Destination directory for all downloaded files
├── extension/                  # Manifest V3 browser extension (Chrome / Edge / Brave)
│   ├── background.js           # Extension background service worker
│   ├── content.js              # Magnet link interception and DOM injector
│   ├── manifest.json           # Extension manifest definition
│   ├── popup.html              # Extension settings UI
│   └── popup.js                # Extension options and API key management
├── public/                     # Glassmorphic Frontend Web Dashboard
│   ├── css/
│   │   └── style.css           # Modern Cyberpunk / Glassmorphism design system
│   ├── js/
│   │   ├── app.js              # UI controller, WebSocket client, Canvas renderer
│   │   └── turboDownloader.js  # IDM-style browser multi-stream download engine
│   ├── favicon.png             # Application icon
│   └── index.html              # Dashboard layout and modal controllers
├── server/                     # Backend Daemon & Services
│   ├── authService.js          # Authentication, password hashing, JWT, Google OAuth
│   ├── index.js                # Express REST API, WebSocket server & stream routing
│   ├── peerOptimizer.js        # Swarm scoring, choke eviction & peer optimizer
│   ├── proxyService.js         # SOCKS5/HTTP/HTTPS proxy agent manager
│   ├── searchEngine.js         # Swarm indexer search & webpage link sniffer
│   ├── securityMiddleware.js   # RBAC, token verification, rate limiters & guards
│   ├── torrentManager.js       # WebTorrent core engine, memory watchdog & queue
│   ├── trackerService.js       # Live tracker harvester & swarm booster
│   └── userManager.js          # Multi-user accounts, roles and quota enforcement
├── Dockerfile                  # Production Debian Bookworm Slim container build
├── deploy.sh                   # 1-Click automated VPS deployment & kernel tuning script
├── docker-compose.yml          # Container configuration and resource boundaries
├── package.json                # Node.js dependencies and lifecycle scripts
├── proxy-config.json           # Persistent proxy settings
├── security-config.json        # Persistent security, OAuth, and quota configuration
├── session.json                # Saved torrent states across daemon restarts
└── users.json                  # Persistent user registry
```

---

## 🖥 Quick Start & Deployment

### Option A: 1-Click VPS Deployment (Recommended)

Run the automated deployment script on Ubuntu, Debian, or any Linux VPS:

```bash
chmod +x deploy.sh
./deploy.sh
```

**What `deploy.sh` does automatically:**
1. Installs Docker Engine & Compose plugin if not already present.
2. Configures UFW firewall rules for Port `3000` (Web UI) and Port `6881` (BitTorrent TCP/UDP).
3. Allocates a 3 GB emergency swapfile to prevent out-of-memory kernel kills on small VPS instances.
4. Tunes Linux kernel VM parameters (`vm.swappiness = 15`, `vm.dirty_background_ratio = 5`, `vm.dirty_ratio = 10`) to prevent disk freezes under heavy I/O.
5. Builds and launches the container in detached mode with memory reservation limits.

Access your dashboard at: `http://YOUR-SERVER-IP:3000`

---

### Option B: Manual Docker Compose

Launch the stack using Docker Compose directly:

```bash
docker compose up -d
```

To view real-time logs:
```bash
docker compose logs -f
```

To stop the service:
```bash
docker compose down
```

---

### Option C: Native Node.js Deployment

Ensure you have **Node.js 20+** (or Node.js 24) installed:

```bash
# 1. Install dependencies
npm install --omit=dev

# 2. Start daemon
npm start
```

For development with live reloading:
```bash
npm run dev
```

Open your browser to: `http://localhost:3000` (or `http://YOUR-SERVER-IP:3000`).

---

### Option D: Browser Extension Setup

1. Open Chrome, Edge, or Brave and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in top-right corner).
3. Click **Load unpacked** and select the `extension/` folder inside this repository.
4. Click the HyperTorrent icon in your browser toolbar:
   - Enter your **Server URL** (e.g. `http://YOUR-VPS-IP:3000`).
   - Enter your **API Key** (found in Dashboard > Security Settings).
5. Any magnet link clicked on any web page will now automatically queue directly to your VPS!

---

## ⚙️ Configuration & Environment Variables

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP port for the Web Dashboard and REST API |
| `TORRENT_PORT` | `6881` | BitTorrent wire protocol port (TCP & UDP) |
| `DOWNLOAD_DIR` | `./downloads` | Absolute or relative path for downloaded files |
| `NODE_ENV` | `production` | Node execution environment |
| `NODE_OPTIONS` | `--max-old-space-size=1536` | Memory heap limit for the V8 runtime |
| `MAX_ACTIVE_TORRENTS` | `4` | Maximum torrents downloading concurrently |
| `MAX_CONNS_PER_TORRENT` | `35` | Maximum peer connections per active torrent |
| `AUTO_PAUSE_COMPLETED` | `true` | Automatically pause torrents when 100% finished |

### Security & Authentication Config

Security settings are saved in `security-config.json` and configurable in the Admin Web UI:
- **`authEnabled`**: Enables password/token protection for remote traffic.
- **`requireLocalAuth`**: When `false`, localhost connections bypass authentication for local testing.
- **`apiKey`**: Secret key used by the browser extension and external scripts.
- **`defaultUserQuota`**: Default limits assigned to new registered users:
  - `maxActiveTorrents`: Max concurrent downloading torrents.
  - `maxStorageBytes`: Maximum disk space allocated to user files.
  - `maxTorrentSizeBytes`: Maximum size allowed for a single torrent.

### Google OAuth 2.0 Setup

To enable 1-Click Google Login on your VPS:
1. Open the [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth 2.0 Client ID** (Application type: *Web application*).
3. Add the Authorized Redirect URI:
   ```
   http://YOUR-VPS-IP:3000/api/auth/google/callback
   ```
4. Enter your `Client ID` and `Client Secret` in the HyperTorrent Admin Settings modal (or `security-config.json`).
5. (Optional) Set allowed domains or whitelist emails in `adminEmails` / `allowedDomains`.

### Proxy Configuration

Proxy settings are persisted in `proxy-config.json`:
- **`type`**: `socks5`, `http`, or `https`
- **`host`**: Proxy server hostname or IP address
- **`port`**: Proxy port (e.g. `1080`)
- **`username` / `password`**: Optional proxy authentication credentials

---

## 📡 API Reference

All protected endpoints require either a valid JWT cookie (`ht_token`), a Bearer token (`Authorization: Bearer <token>`), or an API key (`x-api-key: <key>`).

### Authentication & Security Endpoints

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/auth/status` | Public | Returns setup status and auth mode |
| `POST` | `/api/auth/setup` | Public | Set initial master password on first launch |
| `POST` | `/api/auth/login` | Public | Authenticate with master password |
| `GET` | `/api/auth/google` | Public | Initiate Google OAuth 2.0 redirect |
| `GET` | `/api/auth/google/callback` | Public | Google OAuth 2.0 callback handler |
| `POST` | `/api/auth/logout` | Protected | Invalidate session cookie |
| `GET` | `/api/auth/me` | Protected | Return currently logged-in user profile |
| `GET` | `/api/auth/api-key` | Admin | Get active API key |
| `POST` | `/api/auth/regenerate-key` | Admin | Rotate and generate a new API key |
| `PUT` | `/api/auth/settings` | Admin | Update master password and auth flags |
| `GET` | `/api/auth/google-config` | Admin | Retrieve Google OAuth & whitelist settings |
| `PUT` | `/api/auth/google-config` | Admin | Update Google OAuth credentials and whitelist |

### User Administration & Quotas

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/users` | Admin | List all registered users with disk usage stats |
| `PUT` | `/api/users/:userId/role` | Admin | Promote or demote user (`admin` / `user`) |
| `PUT` | `/api/users/:userId/quota` | Admin | Modify active torrent & disk quotas for a user |
| `PUT` | `/api/users/:userId/status` | Admin | Activate or suspend user account |
| `DELETE` | `/api/users/:userId` | Admin | Remove user account from registry |

### Torrent Lifecycle & Acceleration

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/status` | Protected | Global engine telemetry (speeds, counts, ratios) |
| `GET` | `/api/torrents` | Protected | List torrents (filtered by user role) |
| `GET` | `/api/torrents/:infoHash` | Protected | Detailed torrent data (pieces, peers, files, trackers) |
| `POST` | `/api/torrents/magnet` | Protected | Add torrent via Magnet URI, URL, or InfoHash |
| `POST` | `/api/torrents/upload` | Protected | Upload and parse `.torrent` file (`multipart/form-data`) |
| `POST` | `/api/torrents/:infoHash/pause` | Protected | Pause an active torrent |
| `POST` | `/api/torrents/:infoHash/resume` | Protected | Resume a paused torrent |
| `POST` | `/api/torrents/:infoHash/sequential` | Protected | Toggle sequential piece downloading mode |
| `POST` | `/api/torrents/:infoHash/boost` | Protected | ⚡ Turbo Boost single torrent (Inject live trackers) |
| `POST` | `/api/torrents/boost-all` | Protected | ⚡ Turbo Boost all active torrents |
| `POST` | `/api/torrents/:infoHash/optimize` | Protected | Run manual peer scoring & choke evaluation |
| `DELETE` | `/api/torrents/:infoHash?deleteFiles=true` | Protected | Delete torrent with optional file removal |

### Cloud Seedbox Transfers & Streaming

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/download/:infoHash/:fileIndex` | Protected | Direct HTTPS file download with RFC 7233 range support |
| `GET` | `/api/download/:infoHash/:fileIndex/meta` | Protected | Capability and metadata probe for Turbo Downloader |
| `GET` | `/api/download/:infoHash/zip` | Protected | Stream entire torrent as a ZIP archive on-the-fly |
| `GET` | `/api/stream/:infoHash/:fileIndex` | Protected | In-flight media stream (HTML5 Video/Audio 206 Partial Content) |
| `POST` | `/api/torrents/:infoHash/files/:fileIndex/priority` | Protected | Select or skip an individual file |

### Search, Sniffer & Trackers

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/search?q=...&autoAdd=true` | Protected | Search indexers, filter by highest seeds, optional auto-add |
| `POST` | `/api/sniff-page` | Protected | Extract and filter magnet links from any web URL |
| `GET` | `/api/trackers/live` | Protected | Fetch live harvested tracker list & stats |
| `GET` | `/api/optimizer/stats` | Protected | Retrieve PeerOptimizer evaluation telemetry |

### Proxy, Queue & Disk Maintenance

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/proxy` | Protected | Get current proxy routing status |
| `PUT` | `/api/proxy` | Admin | Update proxy configuration |
| `POST` | `/api/proxy/test` | Admin | Test live proxy connectivity |
| `GET` | `/api/queue` | Protected | Inspect concurrency queue & memory telemetry |
| `PUT` | `/api/queue` | Admin | Update concurrency limits & memory thresholds |
| `GET` | `/api/disk` | Admin | Fetch live SSD storage space metrics |
| `POST` | `/api/disk/cleanup` | Admin | Manually purge completed torrents by age |
| `PUT` | `/api/disk/auto-cleanup` | Admin | Configure retention hours and auto-cleanup flags |

### Real-Time WebSocket Protocol (`/ws`)

Connect to `/ws` with a session cookie or token query parameter (`/ws?token=...`).

- **Server Broadcast (`tick`)**: Emitted every `1000ms` with system bandwidth, user torrent states, and progress.
- **Client Subscribe (`subscribe_details`)**:
  ```json
  { "type": "subscribe_details", "infoHash": "4a7b..." }
  ```
- **Server Response (`torrent_details`)**: Emits high-frequency piece bitfield arrays, connected peer lists, and tracker statuses for the inspector drawer.
- **Client Unsubscribe (`unsubscribe_details`)**:
  ```json
  { "type": "unsubscribe_details" }
  ```

---

## 🔒 Production Hardening & Reverse Proxy

For production cloud deployments, it is recommended to run HyperTorrent behind Nginx or Caddy with SSL/TLS encryption.

### Nginx Example Configuration

```nginx
server {
    listen 80;
    server_name seedbox.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name seedbox.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/seedbox.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/seedbox.yourdomain.com/privkey.pem;

    # Large file upload and download support
    client_max_body_size 50M;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 📄 License

HyperTorrent is open-source software licensed under the **ISC License**.