# YAMS Repository Worker

Cloudflare Worker serving APT/YUM packages, plugin registry, and browsable directory listings from R2.

## API Endpoints

### Repository Access
- `GET /aptrepo/*` - APT packages and metadata
- `GET /yumrepo/*` - YUM packages and repodata
- `GET /plugins/*` - Plugin bundles (`.tar.gz`)
- `GET /latest.json` - Latest release manifest
- `GET /gpg.key` - GPG public key for verification

### Plugin Registry API
- `GET /api/v1/plugins` - List all plugins
- `GET /api/v1/plugins/:name` - Plugin metadata
- `GET /api/v1/plugins/:name/versions` - All versions
- `GET /api/v1/plugins/:name/:version` - Specific version
- `GET /api/v1/plugins/:name/latest` - Latest version
- `POST /api/v1/plugins/:name/install` - Track installation (metrics)

## License

Apache-2.0
