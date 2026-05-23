# HEN Worker

Dynamic rendering service on Cloudflare Workers that generates PNG images of the Goban (Go/Weiqi) from HEN (Hemme Notation) strings.

## Architecture

- The Worker intercepts URLs in the format `[options]/hen<hen_string>.png`
- Parses the HEN string and generates a Goban SVG
- Converts the SVG to PNG via `@resvg/resvg-wasm` (WebAssembly)
- Embeds the HEN string as a `tEXt` metadata chunk in the PNG (readable with `exiftool`)
- Serves the PNG with an immutable cache header (1 year)
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
http://localhost:8787/c/hen.19x19.b_16DbQw.png
```

## Deploy

```bash
npm run deploy
```

On first deploy, Wrangler will prompt you to authenticate with Cloudflare.

## URL Format

```
/[options]/hen<hen_string>.png
```

### Options

Options are placed in the path before `hen`, enclosed between `/`:

| Option | Effect |
|--------|--------|
| `c` | Show coordinates (column letters + row numbers) |

Example: `/c/hen.19x19.b_16DbQw.png`

### HEN String

The HEN string is a compact notation for describing a Go position.
For details on the HEN format, see the [HEN specification](https://github.com/hemme/hen-spec).

### Examples

```
# 19×19 Goban with a black stone at Q16
hen.19x19.b_16Db.png

# With coordinates
/c/hen.19x19.b_16Db.png

# Full position with last move, ko, and mark
hen.19x19_19bwb2w3_10Kb_8Kbw_7JbwMw_6Kbw_1Cw3bNwb2.L7.K7w.b.png

# 9×9 Goban
hen.9x9_9b3w3b_7w5w_5b2w3b2w_3b6w_1b2w3b2w.png
```

## Rate Limiting

The Worker enforces IP-based rate limiting using a Cloudflare KV namespace (`RATE_LIMIT`).

| Parameter | Value | Description |
|-----------|-------|-------------|
| `RATE_LIMIT` | 20 | Max requests per IP per window |
| `RATE_LIMIT_WINDOW` | 60 s | Sliding window duration |

- IPv4 addresses are tracked as-is
- IPv6 addresses are normalized to their `/64` prefix (first 4 blocks), so all devices in the same /64 share the limit
- When the limit is exceeded, the Worker returns `429 Too Many Requests` with a `Retry-After` header
- Rate limit state is stored in KV with a TTL slightly above the window duration, so entries auto-expire

### KV Binding

The `RATE_LIMIT` KV namespace is configured in `wrangler.toml` (see `wrangler.toml.template` for the required structure). The namespace ID must match an existing KV namespace in your Cloudflare account.

## Extracting the HEN String from a PNG

Every generated PNG embeds the original HEN string in a `tEXt` metadata chunk with the keyword `HEN`. You can retrieve it with any tool that reads PNG text chunks.

### exiftool

```bash
exiftool -HEN image.png
# HEN : .19x19.b_16DbQw
```

### Python (Pillow)

```python
from PIL import Image

img = Image.open("image.png")
print(img.text.get("HEN"))
```

### JavaScript (Node.js)

```js
import { readFileSync } from "fs";
import extractChunks from "png-chunks-extract";
import textChunk from "png-chunk-text";

const data = readFileSync("image.png");
const chunks = extractChunks(data).filter(c => c.name === "tEXt");
const text = Object.fromEntries(chunks.map(c => textChunk.decode(c.data)));
console.log(text.HEN);
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