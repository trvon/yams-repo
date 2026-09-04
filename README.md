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

### Experimental channel

Nightly and weekly releases share one experimental repository namespace. They
never publish to the stable keys above:

- APT: `https://repo.yamsmemory.ai/experimental/aptrepo` with distribution
  `experimental`
- YUM: `https://repo.yamsmemory.ai/experimental/yumrepo/`
- Arch: `https://repo.yamsmemory.ai/experimental/archrepo/os/$arch`
- Manifest: `https://repo.yamsmemory.ai/experimental/latest.json`
- APT public key:
  `https://repo.yamsmemory.ai/experimental/aptrepo/gpg.key`

Do not configure a stable client to use an experimental URL or signing key.

## Repository publication operations

Stable and experimental publication are separate authorities. Keep the existing
stable credentials in `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`GPG_PRIVATE_KEY`, `GPG_PASSPHRASE`, and `GPG_PUBLIC_KEY_B64`. Provision distinct
experimental credentials in `EXPERIMENTAL_CLOUDFLARE_API_TOKEN`,
`EXPERIMENTAL_CLOUDFLARE_ACCOUNT_ID`, `EXPERIMENTAL_GPG_PRIVATE_KEY`,
`EXPERIMENTAL_GPG_PASSPHRASE`, and `EXPERIMENTAL_GPG_PUBLIC_KEY_B64`. Never copy
the stable signing key or stable R2 token into an experimental secret. Scope each
Cloudflare token to only the repository authority needed by its workflow; the
publisher additionally enforces the channel prefix in its validated plan.

Publication is deliberately ordered:

1. Validate the downloaded `release-manifest` artifact against the selected
   Release run ID, run attempt, source ref, and requested publication channel.
2. Upload immutable package payloads. An existing byte-identical object is an
   idempotent success; an existing object with different bytes is a hard conflict.
3. Upload mutable repository metadata and that channel's public key.
4. Write that channel's `latest.json` last.

If a run stops before `latest.json`, do not delete or prune anything. Fix the
failed step and rerun the same Release run and attempt through
`publish-repos.yml`; identical immutable payloads are skipped, metadata is
replayed, and `latest.json` advances only after all prior writes succeed. If the
final `latest.json` write itself fails, use the same recovery. Never prune old
packages as part of publishing or recovery: repository metadata or existing
clients may still reference them, and immutable-object conflicts must be
investigated rather than overwritten.

For experimental republishing, `run_id` is mandatory. For stable republishing,
an explicit run ID is preferred; leaving it empty selects the latest successful
tag-triggered Release run. In both cases, the manifest channel is authoritative
and a stable/experimental mismatch fails closed before any R2 operation.

## Endpoints

### Repository Paths

- `GET /aptrepo/*` - APT packages and metadata
- `GET /yumrepo/*` - YUM packages and repodata
- `GET /archrepo/*` - Arch packages and pacman repo metadata
  - browse root: `/archrepo/`
  - package indexes: `/archrepo/os/x86_64/`, `/archrepo/os/aarch64/`
- `GET /plugins/*` - Plugin archives (`.tar.gz`)
- `GET /latest.json` - Latest release manifest
- `GET /gpg.key` - Stable public key for package verification
- `GET /experimental/aptrepo/*` - Experimental APT packages and metadata
- `GET /experimental/yumrepo/*` - Experimental YUM packages and repodata
- `GET /experimental/archrepo/*` - Experimental Arch packages and metadata
- `GET /experimental/latest.json` - Latest nightly or weekly release manifest

Repository routes use exact segment boundaries. Encoded paths, traversal
segments, and lookalike prefixes such as `/aptrepository` are rejected.

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
