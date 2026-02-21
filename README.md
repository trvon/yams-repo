# YAMS Repository Worker

Cloudflare Worker serving APT/YUM packages, plugin registry, and browsable directory listings from R2.

**Base URL:** `https://repo.yamsmemory.ai`

## Install YAMS

### Debian / Ubuntu (APT)

```bash
# Add the repository (unsigned — GPG signing coming soon)
echo "deb [trusted=yes] https://repo.yamsmemory.ai/aptrepo stable main" \
  | sudo tee /etc/apt/sources.list.d/yams.list

# Install
sudo apt-get update && sudo apt-get install yams
```

Once GPG signing is configured:

```bash
curl -fsSL https://repo.yamsmemory.ai/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/yams.gpg

echo "deb [signed-by=/usr/share/keyrings/yams.gpg] https://repo.yamsmemory.ai/aptrepo stable main" \
  | sudo tee /etc/apt/sources.list.d/yams.list

sudo apt-get update && sudo apt-get install yams
```

### Fedora / RHEL / openSUSE (YUM / DNF)

```bash
sudo tee /etc/yum.repos.d/yams.repo <<'REPO'
[yams]
name=YAMS Repository
baseurl=https://repo.yamsmemory.ai/yumrepo/
enabled=1
gpgcheck=0
repo_gpgcheck=0
REPO

sudo dnf makecache && sudo dnf install yams
```

### macOS (Homebrew)

```bash
brew install trvon/yams/yams
```

### Direct Download

Download the latest release archive or package directly:

```bash
# Check the latest release manifest
curl -fsSL https://repo.yamsmemory.ai/latest.json | jq .

# Or download from GitHub Releases
gh release download --repo trvon/yams --pattern 'yams-*-linux-x86_64.deb'
sudo dpkg -i yams-*-linux-x86_64.deb
```

## API Endpoints

### Repository Access
- `GET /aptrepo/*` — APT packages and metadata
- `GET /yumrepo/*` — YUM packages and repodata
- `GET /plugins/*` — Plugin bundles (`.tar.gz`)
- `GET /latest.json` — Latest release manifest
- `GET /gpg.key` — GPG public key for verification

### Plugin Registry API
- `GET /api/v1/plugins` — List all plugins
- `GET /api/v1/plugins/:name` — Plugin metadata
- `GET /api/v1/plugins/:name/versions` — All versions
- `GET /api/v1/plugins/:name/:version` — Specific version
- `GET /api/v1/plugins/:name/latest` — Latest version
- `POST /api/v1/plugins/:name/install` — Track installation (metrics)

### Browsable Index

All repository paths serve an HTML directory listing when accessed in a browser (e.g., `https://repo.yamsmemory.ai/aptrepo/`).

## Development

```bash
cd worker
npm install
npm run dev       # wrangler dev
npm test          # vitest
```

## License

Apache-2.0
