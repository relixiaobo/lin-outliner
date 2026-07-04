# Bundled ripgrep

Tenon bundles ripgrep so local agent search does not depend on `rg` being
installed on the user's shell `PATH`.

## Version

- Upstream: https://github.com/BurntSushi/ripgrep
- Release: `15.1.0`
- Release page: https://github.com/BurntSushi/ripgrep/releases/tag/15.1.0
- License: dual MIT or Unlicense, copied here as `LICENSE-MIT` and `UNLICENSE`.

## Artifacts

| Directory | Upstream asset | Archive SHA-256 | Extracted `rg` SHA-256 |
|---|---|---|---|
| `arm64-darwin/` | `ripgrep-15.1.0-aarch64-apple-darwin.tar.gz` | `378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715` | `4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94` |
| `x64-darwin/` | `ripgrep-15.1.0-x86_64-apple-darwin.tar.gz` | `64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882` | `3bafa7e6ee51ba3ac4ed065883484a309be09b26ea6dad561ae4049bfe049c50` |

Only the `rg` executable is shipped in app resources. The upstream license files
stay in this directory for provenance.
