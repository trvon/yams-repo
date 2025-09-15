# YAMS Repository Cloudflare Worker

Serves APT and YUM repository artifacts plus a `latest.json` manifest from an R2 bucket.

## Features
- APT repo under `/aptrepo` (mirrors bucket prefix `aptrepo/`)
- YUM repo under `/yumrepo` (mirrors `yumrepo/`)
- `latest.json` manifest for update clients
- Optional `gpg.key` route for repository signing key
- Security headers, cache-control (immutable for packages)

## Bucket Layout
```
aptrepo/
  dists/stable/Release
  dists/stable/InRelease (optional)
  dists/stable/main/binary-amd64/Packages
  pool/main/y/yams/*.deb
yumrepo/
  repodata/repomd.xml
  *.rpm
latest.json
gpg.key (optional)
```

## Deployment
1. Install wrangler: `npm install -g wrangler`
2. Configure `wrangler.toml` bucket binding names.
3. Publish: `wrangler publish`

## TODO / Enhancements
- Directory listing / simple HTML index.
- Rate limiting abusive requests.
- RPM & DEB signature verification helper endpoints.
- Multi-arch (arm64) `Packages` & YUM subdirs.
