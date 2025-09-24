#!/bin/bash
set -e

echo "=== Automated Squid Proxy Setup ==="
echo "Installing and configuring Squid with round-robin parents (10000-20000) and domain whitelist"

echo "Checking privileges..."
if [[ $EUID -eq 0 ]]; then
  echo "Don't run this script as root. It will use sudo when needed."
  exit 1
fi

# Baked-in upstream proxy creds
PROXY_HOST="gw.dataimpulse.com"
PROXY_USER="eedab598a442742a9299__cr.nz,se,ch,us,gb,ae,ca,fi"
PROXY_PASS="d7ae1e9450fcc20a"

# Load TARGET_URL from .env (required)
if [[ -f .env ]]; then
  export $(grep -v '^#' .env | xargs || true)
fi
if [[ -z "$TARGET_URL" ]]; then
  echo "ERROR: TARGET_URL is required in .env"
  exit 1
fi
TARGET_DOMAIN=$(echo "$TARGET_URL" | sed -E 's|^https?://([^/]+).*|\1|')

echo "Proxy host: $PROXY_HOST (round-robin ports 10000-20000)"
echo "Target URL: $TARGET_URL (domain: $TARGET_DOMAIN)"

echo "Detecting OS..."
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS=$NAME
  VER=$VERSION_ID
else
  echo "Cannot determine OS version"; exit 1
fi

echo "Detected OS: $OS $VER"

echo "Installing Squid..."
if [[ "$OS" == *"Ubuntu"* ]] || [[ "$OS" == *"Debian"* ]]; then
  sudo apt update -y
  sudo apt install -y squid
else
  sudo yum -y install squid || true
fi

echo "Stopping default Squid..."
sudo systemctl stop squid || true

echo "Backing up existing config..."
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.bak 2>/dev/null || true

echo "Generating optimized squid.conf (round-robin + whitelist)..."
TMPCONF=$(mktemp)
cat > "$TMPCONF" << 'EOBASE'
# Phantom Bot Squid Configuration (Round-robin parents)
http_port 3128
pid_filename /var/run/squid.pid
cache deny all
visible_hostname phantom-proxy

# Performance tuning
max_filedescriptors 8192
dns_nameservers 1.1.1.1 9.9.9.9
dns_timeout 10 seconds

# Parent proxies (generated below)
EOBASE

# Generate parent peers 10000..20000 with round-robin
for port in $(seq 10000 20000); do
  echo "cache_peer $PROXY_HOST parent $port 0 no-query round-robin login=$PROXY_USER:$PROXY_PASS name=dp$port" >> "$TMPCONF"
done

cat >> "$TMPCONF" << EOF

# Domain whitelist (prevent leaks to pricey upstream)
acl allowed_domains dstdomain .popcash.net .pcdelv.com $TARGET_DOMAIN api.ipify.org

# Route only whitelisted domains via parents
acl CONNECT method CONNECT
acl SSL_ports port 443

# Only allow traffic to whitelisted domains (including CONNECT)
http_access allow CONNECT allowed_domains
http_access allow allowed_domains
http_access deny all

# Force whitelisted domains through parents (no direct)
never_direct allow allowed_domains
always_direct deny allowed_domains

# Basic logging
access_log stdio:/var/log/squid/access.log squid
cache_log /var/log/squid/cache.log

EOF

echo "Installing squid.conf..."
sudo mkdir -p /etc/squid
sudo cp "$TMPCONF" /etc/squid/squid.conf
sudo rm -f "$TMPCONF"

echo "Restarting Squid..."
sudo systemctl enable --now squid || true
sudo systemctl restart squid || true
echo "Squid status:"
sudo systemctl --no-pager status squid | sed -n '1,80p' || true
echo "Recent access log entries (if any):"
sudo tail -n 50 /var/log/squid/access.log 2>/dev/null || true
