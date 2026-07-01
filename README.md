# YAMS Package Repository

YAMS package and plugin distribution service, backed by Cloudflare Workers
and R2.

- Base URL: `https://repo.yamsmemory.ai`
- Serves: APT, YUM/DNF, Arch/pacman, plugin bundles, and plugin registry
  APIs
- Worker routes map to bucket prefixes via `APT_PREFIX`, `YUM_PREFIX`, and
  `ARCH_PREFIX`

## Install `yams`

### Debian / Ubuntu (APT)

Current setup (unsigned repo):

```bash
echo "deb [trusted=yes] https://repo.yamsmemory.ai/aptrepo stable main" \
  | sudo tee /etc/apt/sources.list.d/yams.list
sudo apt-get update
sudo apt-get install yams
```

Signed setup (use when signing is enabled):

```bash
curl -fsSL https://repo.yamsmemory.ai/gpg.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/yams.gpg

echo "deb [signed-by=/usr/share/keyrings/yams.gpg] https://repo.yamsmemory.ai/aptrepo stable main" \
  | sudo tee /etc/apt/sources.list.d/yams.list
sudo apt-get update
sudo apt-get install yams
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

sudo dnf makecache
sudo dnf install yams
```

### Arch Linux (pacman)

Current setup (unsigned repo):

```bash
sudo tee /etc/pacman.d/yams.conf <<'REPO'
[yams]
SigLevel = Optional TrustAll
Server = https://repo.yamsmemory.ai/archrepo/os/$arch
REPO

sudo tee -a /etc/pacman.conf <<'REPO'
Include = /etc/pacman.d/yams.conf
REPO

sudo pacman -Sy yams
```

The worker serves the standard Arch layout under `/archrepo/os/$arch/`:

- `yams.db`
- `yams.files`
- `*.pkg.tar.zst`

### macOS (Homebrew)

```bash
brew install trvon/yams/yams
```

### Direct Download

```bash
# Inspect latest release metadata
curl -fsSL https://repo.yamsmemory.ai/latest.json | jq .

# Download package from GitHub Releases
gh release download --repo trvon/yams --pattern 'yams-*-linux-x86_64.deb'
sudo dpkg -i yams-*-linux-x86_64.deb
```

## Endpoints

### Repository Paths

- `GET /aptrepo/*` - APT packages and metadata
- `GET /yumrepo/*` - YUM packages and repodata
- `GET /archrepo/*` - Arch packages and pacman repo metadata
  - browse root: `/archrepo/`
  - package indexes: `/archrepo/os/x86_64/`, `/archrepo/os/aarch64/`
- `GET /plugins/*` - Plugin archives (`.tar.gz`)
- `GET /latest.json` - Latest release manifest
- `GET /gpg.key` - Public key for package verification

### Plugin Registry API

- `GET /api/v1/plugins` - List plugins
- `GET /api/v1/plugins/:name` - Plugin metadata
- `GET /api/v1/plugins/:name/versions` - All plugin versions
- `GET /api/v1/plugins/:name/:version` - Version metadata
- `GET /api/v1/plugins/:name/latest` - Latest plugin version
- `POST /api/v1/plugins/:name/install` - Installation telemetry endpoint

### Browsable Indexes

Repository paths are browsable in a web browser, for example:

- `https://repo.yamsmemory.ai/aptrepo/`
- `https://repo.yamsmemory.ai/yumrepo/`
- `https://repo.yamsmemory.ai/archrepo/`
- `https://repo.yamsmemory.ai/archrepo/os/x86_64/`

## Development (Worker)

Requirements: Node.js `>= 22`

```bash
cd worker
npm install
npm run lint
npm run typecheck
npm test
npm run dev
```

Worker config in `worker/wrangler.toml` expects:

- `APT_PREFIX=aptrepo`
- `YUM_PREFIX=yumrepo`
- `ARCH_PREFIX=archrepo`
- `LATEST_MANIFEST=latest.json`
- `CORS_ALLOWED_ORIGINS=...` for allowed web origins

## License

Apache-2.0
