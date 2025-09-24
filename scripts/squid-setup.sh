#!/bin/bash

set -e

echo "=== Automated Squid Proxy Setup ==="
echo "Installing and configuring Squid with embedded credentials"
echo ""

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo "Don't run this script as root. It will use sudo when needed."
   exit 1
fi

# Hardcoded proxy settings (baked in)
PROXY_HOST="gw.dataimpulse.com"
PROXY_USER="eedab598a442742a9299__cr.nz,se,ch,us,gb,ae,ca,fi"
PROXY_PASS="d7ae1e9450fcc20a"
PROXY_PORT="10000"
TARGET_DOMAIN="eus.lat"

echo "Using proxy: $PROXY_HOST:$PROXY_PORT"
echo "Target domain: $TARGET_DOMAIN"
echo ""

# Check OS
if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS=$NAME
    VER=$VERSION_ID
else
    echo "Cannot determine OS version"
    exit 1
fi

echo "Detected OS: $OS $VER"

# Install Squid based on OS
echo "Installing Squid..."
if [[ "$OS" == *"Ubuntu"* ]] || [[ "$OS" == *"Debian"* ]]; then
    sudo apt update
    sudo apt install -y squid
elif [[ "$OS" == *"Amazon Linux"* ]] || [[ "$OS" == *"CentOS"* ]] || [[ "$OS" == *"Red Hat"* ]]; then
    sudo yum -y install squid
else
    echo "Unsupported OS. Please install squid manually."
    exit 1
fi

echo "✓ Squid installed successfully"

# Stop default Squid instance
echo "Stopping default Squid service..."
sudo systemctl stop squid

# Backup original config
echo "Backing up original squid.conf..."
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.bak

echo "Generating optimized squid.conf..."

# Create new squid.conf with embedded credentials
sudo tee /etc/squid/squid.conf > /dev/null <<EOF
# Phantom Bot Squid Configuration
# Auto-generated with embedded credentials

# Basic settings
http_port 3128
pid_filename /var/run/squid.pid
cache deny all
visible_hostname phantom-proxy

# Performance tuning
max_filedescriptors 8192
dns_nameservers 1.1.1.1 9.9.9.9
dns_timeout 10 seconds

# Parent proxy with embedded credentials
cache_peer $PROXY_HOST parent $PROXY_PORT 0 no-query default \\
            login=$PROXY_USER:$PROXY_PASS \\
            name=residential_proxy \\
            connect-timeout=30 \\
            connect-fail-limit=3

# Whitelist only essential domains
acl allowed_domains dstdomain .popcash.net .pcdelv.com $TARGET_DOMAIN

# Routing: only allowed domains go to parent proxy
cache_peer_access residential_proxy allow allowed_domains
cache_peer_access residential_proxy deny all

# Access control: allow whitelisted, deny everything else
http_access allow allowed_domains
http_access deny all

# Minimal logging for performance
access_log none
cache_log /var/log/squid/cache.log
logfile_rotate 2

# Memory optimization
cache_mem 64 MB
maximum_object_size_in_memory 512 KB
EOF

# Set proper permissions
echo "Setting permissions..."
sudo chown -R proxy:proxy /etc/squid/
sudo chmod 640 /etc/squid/squid.conf

# Test configuration
echo "Validating Squid configuration..."
if sudo squid -k parse; then
    echo "✓ Configuration is valid"
else
    echo "✗ Configuration has errors"
    sudo squid -k parse
    exit 1
fi

# Enable and start Squid
echo "Starting Squid service..."
sudo systemctl enable squid
sudo systemctl restart squid

# Wait for Squid to start
sleep 3

# Verify Squid is running
if sudo systemctl is-active --quiet squid; then
    echo "✓ Squid is running successfully"
else
    echo "✗ Squid failed to start"
    sudo systemctl status squid
    exit 1
fi

# Test proxy functionality
echo ""
echo "Testing proxy functionality..."

echo -n "Testing allowed domain (popcash.net)... "
if timeout 10 curl -x http://127.0.0.1:3128 -s -I https://popcash.net >/dev/null 2>&1; then
    echo "✓ PASS"
else
    echo "⚠ FAIL (may be normal if domain unreachable)"
fi

echo -n "Testing blocked domain (google.com)... "
if timeout 3 curl -x http://127.0.0.1:3128 -s -I https://google.com >/dev/null 2>&1; then
    echo "✗ FAIL (should be blocked)"
else
    echo "✓ PASS (blocked as expected)"
fi

echo ""
echo "=== Squid Setup Complete ==="
echo "✓ Squid installed and configured"
echo "✓ Proxy credentials embedded: $PROXY_HOST:$PROXY_PORT"
echo "✓ Domain filtering active: .popcash.net, .pcdelv.com, $TARGET_DOMAIN"
echo "✓ Service running on 127.0.0.1:3128"
echo ""
echo "Your bot will now automatically use Squid for massive cost savings!"
echo ""
echo "Commands:"
echo "  Monitor: sudo tail -f /var/log/squid/cache.log"
echo "  Status:  sudo systemctl status squid"
echo "  Restart: sudo systemctl restart squid"
echo "========================"
