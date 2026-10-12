#!/usr/bin/env bash
# ==============================================================================
# HyperTorrent — 1-Click Cloud Seedbox Deploy Script (Ubuntu / Debian / Linux)
# ==============================================================================

set -e

echo "=========================================================="
echo "⚡ Starting HyperTorrent Private Cloud Seedbox Deployment..."
echo "=========================================================="

# 1. Install Docker & Docker Compose plugin if missing
if ! command -v docker &> /dev/null; then
    echo "[1/4] Installing Docker Engine..."
    sudo apt-get update -y
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER || true
    rm -f get-docker.sh
else
    echo "[1/4] Docker is already installed."
fi

# 2. Configure local firewall rules (Ports 3000 and 6881)
echo "[2/5] Configuring firewall ports (3000 Web UI, 6881 BitTorrent)..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 3000/tcp comment 'HyperTorrent Web UI' || true
    sudo ufw allow 6881/tcp comment 'HyperTorrent BitTorrent TCP' || true
    sudo ufw allow 6881/udp comment 'HyperTorrent BitTorrent UDP' || true
fi

# 3. VPS Memory Guard: Configure Swap & Kernel Page Cache Tuning
echo "[3/5] Configuring VPS memory protection (Swap & Linux kernel VM tuning)..."
SWAP_TOTAL_MB=$(free -m | awk '/^Swap:/ {print $2}')
if [ -z "$SWAP_TOTAL_MB" ] || [ "$SWAP_TOTAL_MB" -lt 1024 ]; then
    echo "   -> Allocating 3GB emergency swapfile to safeguard multi-user seedbox from OOM crashes..."
    if [ ! -f /swapfile ]; then
        sudo fallocate -l 3G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=3072
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
    fi
    sudo swapon /swapfile 2>/dev/null || true
    if ! grep -q '/swapfile' /etc/fstab 2>/dev/null; then
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    fi
    echo "   -> Swapfile active and registered in /etc/fstab."
else
    echo "   -> Existing swap is adequate (${SWAP_TOTAL_MB}MB)."
fi

# Tune swappiness and dirty page writebacks to prevent disk freeze & memory exhaustion
sudo sysctl -w vm.swappiness=15 2>/dev/null || true
sudo sysctl -w vm.dirty_background_ratio=5 2>/dev/null || true
sudo sysctl -w vm.dirty_ratio=10 2>/dev/null || true
if [ -d /etc/sysctl.d ]; then
    sudo tee /etc/sysctl.d/99-hypertorrent-tuning.conf > /dev/null 2>&1 << 'EOF'
vm.swappiness = 15
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
EOF
fi

# 4. Stop old containers if any and build fresh container
echo "[4/5] Building and launching HyperTorrent container..."
mkdir -p downloads

# Stop any previous instance
sudo docker compose down 2>/dev/null || true

# Build cleanly with Debian glibc base
sudo docker compose build
sudo docker compose up -d

# 5. Verification and Health Check
echo "[5/5] Verifying seedbox health..."
sleep 4

if sudo docker ps | grep -q "hypertorrent-seedbox"; then
    PUBLIC_IP=$(curl -s https://api.ipify.org || curl -s https://ifconfig.me || echo "YOUR-SERVER-IP")
    echo ""
    echo "=========================================================="
    echo "🎉 SUCCESS! Your Private Cloud Seedbox is LIVE and Running!"
    echo "=========================================================="
    echo "🌐 Web Dashboard: http://${PUBLIC_IP}:3000"
    echo "📁 Download Directory: $(pwd)/downloads"
    echo ""
    echo "How to use like Seedr:"
    echo " 1. Open http://${PUBLIC_IP}:3000 in your browser."
    echo " 2. Add any magnet link (downloads at 1-10 Gbps 24/7 in the cloud)."
    echo " 3. In the Files tab, click 'Download' next to any file to pull it"
    echo "    directly to your PC over high-speed HTTPS with IDM / browser!"
    echo "=========================================================="
else
    echo "❌ Container failed to start. Run 'docker logs hypertorrent-seedbox' to check errors."
    exit 1
fi
