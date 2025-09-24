#!/bin/bash
set -euo pipefail

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

# Normalize potential CRLF contamination
PROXY_HOST=$(printf "%s" "$PROXY_HOST" | tr -d '\r')
PROXY_USER=$(printf "%s" "$PROXY_USER" | tr -d '\r')
PROXY_PASS=$(printf "%s" "$PROXY_PASS" | tr -d '\r')

# Load TARGET_URL from .env (required)
if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | xargs || true)
fi
if [[ -z "$TARGET_URL" ]]; then
  echo "ERROR: TARGET_URL is required in .env"
  exit 1
fi
TARGET_URL=$(printf "%s" "$TARGET_URL" | tr -d '\r')
TARGET_DOMAIN=$(printf "%s" "$TARGET_URL" | sed -E 's|^https?://([^/]+).*|\1|' | tr -d '\r')

PROXY_PORT_START="${PROXY_PORT_START:-10000}"
PROXY_PORT_END="${PROXY_PORT_END:-10010}"
echo "Proxy host: $PROXY_HOST (round-robin ports $PROXY_PORT_START-$PROXY_PORT_END)"
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

echo "Backing up existing config (if changed)..."
if [[ -f /etc/squid/squid.conf ]]; then
  if ! cmp -s /etc/squid/squid.conf /etc/squid/squid.conf.bak 2>/dev/null; then
    sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.bak 2>/dev/null || true
  fi
fi

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

# Generate parent peers $PROXY_PORT_START..$PROXY_PORT_END with round-robin
for port in $(seq "$PROXY_PORT_START" "$PROXY_PORT_END"); do
  line="cache_peer $PROXY_HOST parent $port 0 no-query round-robin login=$PROXY_USER:$PROXY_PASS name=dp$port"
  printf '%s\n' "$line" | tr -d '\r' >> "$TMPCONF"
done

cat >> "$TMPCONF" << EOF

# Domain whitelist (prevent leaks to pricey upstream)
acl allowed_domains dstdomain .popcash.net .pcdelv.com $TARGET_DOMAIN ip-api.com
acl localhost src 127.0.0.1/32

# Route only whitelisted domains via parents
acl CONNECT method CONNECT
acl SSL_ports port 443

# Only allow traffic to whitelisted domains (including CONNECT)
http_access allow localhost allowed_domains
http_access allow CONNECT allowed_domains
http_access allow allowed_domains
http_access deny all

# Force whitelisted domains through parents (no direct)
never_direct allow allowed_domains
always_direct deny allowed_domains

# Balance across all parents
cache_peer_access dp10000 allow all
cache_peer_access dp10001 allow all
cache_peer_access dp10002 allow all
cache_peer_access dp10003 allow all
cache_peer_access dp10004 allow all
cache_peer_access dp10005 allow all

# Basic logging
access_log stdio:/var/log/squid/access.log squid
cache_log /var/log/squid/cache.log

EOF

echo "Validating generated config..."
sudo mkdir -p /etc/squid
sudo cp "$TMPCONF" /etc/squid/squid.conf.new
PARSE_ERR=$(mktemp)
if ! sudo squid -k parse -f /etc/squid/squid.conf.new 2>"$PARSE_ERR" >/dev/null; then
  echo "ERROR: Generated squid.conf failed validation. Parser output:" >&2
  sed -n '1,200p' "$PARSE_ERR" >&2 || true
  echo "--- Begin Config Preview ---" >&2
  sudo sed -n '1,160p' /etc/squid/squid.conf.new >&2 || true
  echo "--- End Config Preview ---" >&2
  rm -f "$PARSE_ERR"
  sudo rm -f /etc/squid/squid.conf.new
  exit 1
fi
rm -f "$PARSE_ERR"

echo "Installing squid.conf..."
sudo mv /etc/squid/squid.conf.new /etc/squid/squid.conf
sudo rm -f "$TMPCONF"

echo "Restarting Squid..."
sudo systemctl enable --now squid || true
if ! sudo systemctl restart squid; then
  echo "Squid failed to restart, showing logs:" >&2
  sudo systemctl --no-pager status squid | sed -n '1,120p' >&2 || true
  sudo journalctl -xeu squid --no-pager | sed -n '1,120p' >&2 || true
  exit 1
fi

echo "Testing proxy connectivity (ip-api.com)..."
if ! curl -sS -x http://127.0.0.1:3128 http://ip-api.com/json | sed -n '1,1p' >/dev/null; then
  echo "WARNING: Test request via Squid failed. Check whitelist and network." >&2
fi
echo "Squid status:"
sudo systemctl --no-pager status squid | sed -n '1,80p' || true
echo "Recent access log entries (if any):"
sudo tail -n 50 /var/log/squid/access.log 2>/dev/null || true
