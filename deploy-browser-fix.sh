#!/bin/bash
# deploy-browser-fix.sh - Deploy browser tool fixes to Hostinger VPS

set -e  # Exit on error

echo "========================================="
echo "Aetheria AI - Browser Tool Fix Deployment"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Pull latest code
echo -e "${YELLOW}Step 1: Pulling latest code...${NC}"
git pull origin main
echo -e "${GREEN}✓ Code updated${NC}"
echo ""

# Step 2: Stop containers
echo -e "${YELLOW}Step 2: Stopping containers...${NC}"
docker-compose down
echo -e "${GREEN}✓ Containers stopped${NC}"
echo ""

# Step 3: Rebuild web container (no cache to ensure Playwright installs)
echo -e "${YELLOW}Step 3: Rebuilding web container (this may take 5-10 minutes)...${NC}"
docker-compose build --no-cache web
echo -e "${GREEN}✓ Container rebuilt${NC}"
echo ""

# Step 4: Start containers
echo -e "${YELLOW}Step 4: Starting containers...${NC}"
docker-compose up -d
echo -e "${GREEN}✓ Containers started${NC}"
echo ""

# Step 5: Wait for container to be ready
echo -e "${YELLOW}Step 5: Waiting for container to be ready...${NC}"
sleep 10
echo -e "${GREEN}✓ Container ready${NC}"
echo ""

# Step 6: Verify Playwright installation
echo -e "${YELLOW}Step 6: Verifying Playwright installation...${NC}"
if docker exec aios-web python3 -c "from playwright.sync_api import sync_playwright; print('Playwright OK')" 2>/dev/null; then
    echo -e "${GREEN}✓ Playwright installed successfully${NC}"
else
    echo -e "${RED}✗ Playwright installation failed${NC}"
    echo "Attempting manual installation..."
    docker exec aios-web playwright install --with-deps chromium
    docker-compose restart web
    sleep 5
fi
echo ""

# Step 7: Check Playwright version
echo -e "${YELLOW}Step 7: Checking Playwright version...${NC}"
docker exec aios-web playwright --version || echo -e "${RED}Warning: Could not get Playwright version${NC}"
echo ""

# Step 8: Verify browser installation
echo -e "${YELLOW}Step 8: Verifying Chromium installation...${NC}"
if docker exec aios-web ls /ms-playwright/chromium* 2>/dev/null | grep -q chromium; then
    echo -e "${GREEN}✓ Chromium browser installed${NC}"
else
    echo -e "${RED}✗ Chromium browser not found${NC}"
    echo "This may cause browser automation to fail."
fi
echo ""

# Step 9: Check container health
echo -e "${YELLOW}Step 9: Checking container health...${NC}"
docker-compose ps
echo ""

# Step 10: Show recent logs
echo -e "${YELLOW}Step 10: Recent logs (last 20 lines)...${NC}"
docker logs aios-web --tail 20
echo ""

# Summary
echo "========================================="
echo -e "${GREEN}Deployment Complete!${NC}"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Test browser functionality from mobile app"
echo "2. Monitor logs: docker logs -f aios-web | grep 'Browser Tool'"
echo "3. Check memory usage: docker stats aios-web"
echo ""
echo "To test device detection, send this message:"
echo "  'Navigate to amazon.com'"
echo ""
echo "Expected log output:"
echo "  [Browser Tool] Using SERVER-SIDE browser for mobile"
echo ""
