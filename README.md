# HEN Worker

Dynamic rendering service on Cloudflare Workers that generates **PNG** or **GIF** images of the Goban (Go/Weiqi) from HEN (Hemme Notation) strings.

## Architecture

- The Worker intercepts URLs in the format `[options]/hen<hen_string>.<png|gif>`
- Parses the HEN string and generates a Goban SVG
- Converts the SVG to a raster image via `@resvg/resvg-wasm` (WebAssembly)
  - **PNG**: rendered directly by Resvg
  - **GIF**: rendered to RGBA pixels by Resvg, then quantized + encoded with `gifenc`
- Embeds the HEN string as metadata: a `tEXt` chunk in PNG, or a Comment Extension in GIF (readable with `exiftool` / a GIF parser)
- Serves the image with an immutable cache header (1 year)
- Responds from Cloudflare's edge cache for subsequent requests

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account (free)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a devDependency)

## Installation

```bash
npm install
```

Copy the Wrangler configuration template and fill in your KV namespace ID:

```bash
cp wrangler.toml.template wrangler.toml
```

Edit `wrangler.toml` and replace `YOUR_RATE_LIMIT_KV_ID` with your actual Cloudflare KV namespace ID for the `RATE_LIMIT` binding.

## Local Development

```bash
npm run dev
```

The Worker will be available at `http://localhost:8787`.

Try with a sample URL:

```
http://localhost:8787/hen.19x19.b_16DbQw.png
http://localhost:8787/hen.19x19.b_16DbQw.gif
http://localhost:8787/c/hen.19x19.b_16DbQw.png
```

## Deploy

```bash
npm run deploy
```

On first deploy, Wrangler will prompt you to authenticate with Cloudflare.

Before deploying, the script (`scripts/deploy.mjs`) checks the rate limit configuration stored in KV (`config:limit`, `config:window_minutes`). If a value is **missing or differs** from the defaults defined in `index.js` (20 requests / 240 min), it asks whether to update it.

- In a non-interactive environment (CI, piped stdin) the prompt is skipped and the values are left untouched; use `--yes` to apply the defaults automatically.
- `--no-config` skips the config sync entirely.
- `--dry-run` performs a build without deploying or writing to KV.

```bash
npm run deploy -- --yes        # auto-apply defaults when needed
npm run deploy -- --no-config  # skip KV config sync, just deploy
npm run deploy -- --dry-run    # build only, no deploy / no KV writes
```

## URL Format

```
/[options]/hen<hen_string>.<png|gif>
```

### Options

Options are placed in the path before `hen`, enclosed between `/`:

| Option | Effect |
|--------|--------|
| `c`    | Show coordinates (column letters + row numbers) |
| `x`    | Auto-crop (crops the empty areas of the board around the stones) |

Options can be combined.

Example: `/cx/hen.19x19.b_16DbQw.png` (or `.gif`)

### HEN String

The HEN string is a compact notation for describing a Go position.
For details on the HEN format, see the [HEN specification](https://github.com/hemme/hen-spec).

### Examples

```
# 19×19 Goban with a black stone at Q16
hen.19x19.b_16Db.png

# With coordinates
/c/hen.19x19.b_16Db.png

# With coordinates and auto-crop
/cx/hen.19x19.b_16Db.png

# Full position with last move, ko, and mark
hen.19x19_19bwb2w3_10Kb_8Kbw_7JbwMw_6Kbw_1Cw3bNwb2.L7.K7w.b.png

# 9×9 Goban
hen.9x9_9b3w3b_7w5w_5b2w3b2w_3b6w_1b2w3b2w.png
```

## Rate Limiting

The Worker enforces IP-based rate limiting using a Cloudflare KV namespace (`RATE_LIMIT`). The limit and the window duration are **configurable at runtime** via KV; if the config keys are absent or invalid, the Worker falls back to the built-in defaults.

| KV key | Default | Description |
|--------|---------|-------------|
| `config:limit` | `20` | Max requests per IP per window |
| `config:window_minutes` | `240` | Window duration in minutes (240 = 4 hours) |

- IPv4 addresses are tracked as-is
- IPv6 addresses are normalized to their `/64` prefix (first 4 blocks), so all devices in the same /64 share the limit
- When the limit is exceeded, the Worker returns `429 Too Many Requests` with a `Retry-After` header (seconds) and a message reporting the current limit and window
- Rate limit state is stored in KV with a TTL slightly above the window duration, so entries auto-expire
- The config values are cached in memory for 60s per isolate to avoid reading KV on every request

### Updating rate limit config

Change the limit or window at runtime with Wrangler (use the namespace ID from `wrangler.toml`):

```bash
# Max requests per window
wrangler kv key put --namespace-id=2882606f6bb941a4b170700de5839cc9 "config:limit" "20"

# Window duration in minutes (240 = 4 hours)
wrangler kv key put --namespace-id=2882606f6bb941a4b170700de5839cc9 "config:window_minutes" "240"
```

- If a key is missing, the corresponding default (`20` / `240`) is used.
- KV is eventually consistent and the in-memory cache adds up to ~60s, so an update may take up to about a minute to take effect across all isolates.
- To revert a value to its default, delete the key: `wrangler kv key delete --namespace-id=2882606f6bb941a4b170700de5839cc9 "config:limit"`.

### KV Binding

The `RATE_LIMIT` KV namespace is configured in `wrangler.toml` (see `wrangler.toml.template` for the required structure). The same namespace stores both per-IP rate limit state (keys `rate_limit:<ip>`) and the rate limit configuration (keys `config:*`). The namespace ID must match an existing KV namespace in your Cloudflare account.

## Extracting the HEN String from an image

Every generated image embeds the original HEN string in its metadata with the keyword `HEN`: a `tEXt` chunk in PNG, or a Comment Extension in GIF.

### PNG

#### exiftool

```bash
exiftool -HEN image.png
# HEN : .19x19.b_16DbQw
```

#### Python (Pillow)

```python
from PIL import Image

img = Image.open("image.png")
print(img.text.get("HEN"))
```

#### JavaScript (Node.js)

```js
import { readFileSync } from "fs";
import extractChunks from "png-chunks-extract";
import textChunk from "png-chunk-text";

const data = readFileSync("image.png");
const chunks = extractChunks(data).filter(c => c.name === "tEXt");
const text = Object.fromEntries(chunks.map(c => textChunk.decode(c.data)));
console.log(text.HEN);
```

### GIF

The HEN string is stored as a GIF Comment Extension (`HEN: <string>`).

#### Python

```python
data = open("image.gif", "rb").read()
i = 6  # skip "GIF89a"
while data[i] == 0x21 and data[i + 1] == 0xFE:
    i += 2
    comment = b""
    while data[i] != 0:
        n = data[i]; i += 1
        comment += data[i:i + n]; i += n
    i += 1
    print(comment.decode())
```

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](https://www.gnu.org/licenses/agpl-3.0.en.html) (AGPL-3.0-or-later).

### Third-Party Attributions

This project uses the following third-party components:

| Component | License | Source |
|-----------|---------|--------|
| [@resvg/resvg-wasm](https://github.com/nicdao/resvg-js) | MPL-2.0 | SVG-to-PNG rendering via WebAssembly |
| [@resvg/resvg-js](https://github.com/nicdao/resvg-js) | MPL-2.0 | SVG-to-PNG rendering (native bindings) |
| [Roboto](https://github.com/google/fonts/tree/main/ofl/roboto) | Apache 2.0 | Font used for text rendering |
| [gifenc](https://github.com/mattdesl/gifenc) | MIT | GIF encoding / color quantization |