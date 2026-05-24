#!/bin/bash
# monitor-resources.sh - Monitor Docker container resources

echo "=== Aetheria AI Resource Monitor ==="
echo "Timestamp: $(date)"
echo ""

# Overall system resources
echo "--- System Resources ---"
free -h | grep -E "Mem|Swap"
echo ""

# Docker container stats
echo "--- Container Resources ---"
docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" \
  aios-web aios-redis aios-flower aios-sandbox-manager

echo ""

# Check active browser sessions (if any)
echo "--- Browser Sessions ---"
docker exec aios-web python3 -c "
from browser_tools_server import ServerBrowserTools
print(f'Active contexts: {len(ServerBrowserTools._contexts)}')
print(f'Active pages: {len(ServerBrowserTools._pages)}')
" 2>/dev/null || echo "Browser tool not initialized yet"

echo ""

# Check Redis session count
echo "--- Active Sessions ---"
docker exec aios-redis redis-cli KEYS "session:*" | wc -l | xargs echo "Total sessions:"

echo ""
echo "=== End Report ==="
