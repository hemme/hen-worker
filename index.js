import { Resvg, initWasm } from '@resvg/resvg-wasm';
import wasmModule from '@resvg/resvg-wasm/index_bg.wasm';
import fontData from './fonts/Roboto-Regular.ttf';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

const DEFAULT_RATE_LIMIT = 20;                  // Max requests per window (fallback)
const DEFAULT_RATE_LIMIT_WINDOW_MINUTES = 240;  // 240 min = 4 ore (fallback)

const CONFIG_KEY_LIMIT = 'config:limit';
const CONFIG_KEY_WINDOW_MINUTES = 'config:window_minutes';

const CONFIG_CACHE_TTL_MS = 60 * 1000;
let configCache = null;

const rateLimitCache = new Map();
const KV_SYNC_INTERVAL_SECONDS = 60;

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;
const HEN_LETTERS = 'ABCDEFGHJKLMNOPQRST';
const STAR_POINTS = {
  5: [[2, 2]],
  7: [[1, 1], [1, 5], [3, 3], [5, 1], [5, 5]],
  9: [[2, 2], [2, 6], [4, 4], [6, 2], [6, 6]],
  13: [[3, 3], [3, 6], [3, 9], [6, 3], [6, 6], [6, 9], [9, 3], [9, 6], [9, 9]],
  19: [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]],
};

let wasmInitialized = false;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function insertPngTextChunk(pngBuffer, keyword, text) {
  const kwBytes = new TextEncoder().encode(keyword);
  const txtBytes = new TextEncoder().encode(text);
  const dataLen = kwBytes.length + 1 + txtBytes.length;
  const chunkLen = 4 + 4 + dataLen + 4;

  const typeBytes = new TextEncoder().encode('tEXt');
  const dataForCrc = new Uint8Array(4 + dataLen);
  dataForCrc.set(typeBytes, 0);
  dataForCrc.set(kwBytes, 4);
  dataForCrc[kwBytes.length + 4] = 0;
  dataForCrc.set(txtBytes, kwBytes.length + 5);
  const checksum = crc32(dataForCrc);

  let insertPos = pngBuffer.length - 12;
  let offset = 8;
  while (offset < pngBuffer.length - 8) {
    const chunkType = String.fromCharCode(
      pngBuffer[offset + 4], pngBuffer[offset + 5],
      pngBuffer[offset + 6], pngBuffer[offset + 7]
    );
    if (chunkType === 'IDAT') {
      insertPos = offset;
      break;
    }
    const chunkDataLen = ((pngBuffer[offset] << 24) | (pngBuffer[offset + 1] << 16) |
                         (pngBuffer[offset + 2] << 8) | pngBuffer[offset + 3]) >>> 0;
    offset += 12 + chunkDataLen;
  }

  const chunk = new Uint8Array(chunkLen);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, dataLen, false);
  chunk.set(typeBytes, 4);
  chunk.set(kwBytes, 8);
  chunk[kwBytes.length + 8] = 0;
  chunk.set(txtBytes, kwBytes.length + 9);
  view.setUint32(chunkLen - 4, checksum, false);

  const result = new Uint8Array(pngBuffer.length + chunkLen);
  result.set(pngBuffer.subarray(0, insertPos), 0);
  result.set(chunk, insertPos);
  result.set(pngBuffer.subarray(insertPos), insertPos + chunkLen);
  return result;
}

// GIF Comment Extension: inserts a "keyword: text" comment into the data
// stream, just before the GIF trailer (0x3B). Comment extensions are only
// valid after the Logical Screen Descriptor / Global Color Table, so they
// cannot be placed right after the 6-byte header. Comment data is split into
// sub-blocks of at most 255 bytes, terminated by a 0x00 block.
function insertGifComment(gifBuffer, keyword, text) {
  const payload = new TextEncoder().encode(keyword + ': ' + text);

  const subBlocks = [];
  for (let i = 0; i < payload.length; i += 255) {
    const chunk = payload.subarray(i, Math.min(i + 255, payload.length));
    subBlocks.push(chunk);
  }

  let extLen = 2; // 0x21 introducer + 0xFE comment label
  for (const block of subBlocks) extLen += 1 + block.length;
  extLen += 1; // 0x00 block terminator

  // Trailer is the last byte (0x3B); insert the comment right before it.
  const trailerPos = gifBuffer.length - 1;

  const out = new Uint8Array(gifBuffer.length + extLen);
  out.set(gifBuffer.subarray(0, trailerPos), 0);

  let pos = trailerPos;
  out[pos++] = 0x21; // extension introducer
  out[pos++] = 0xFE; // comment label
  for (const block of subBlocks) {
    out[pos++] = block.length;
    out.set(block, pos);
    pos += block.length;
  }
  out[pos++] = 0x00; // sub-block terminator

  out[trailerPos + extLen] = 0x3B; // trailer
  return out;
}

// Normalize IP (truncates IPv6 to /64)
function getNormalizedIP(request) {
  let ip = request.headers.get("CF-Connecting-IP");
  
  if (ip && ip.includes(':')) {
    // It's an IPv6. Split the blocks.
    const parts = ip.split(':');
    // Keep only the first 4 blocks (first 64 bits) and zero the rest.
    // Example: 2a01:827:2277:be00:... becomes 2a01:827:2277:be00::
    ip = parts.slice(0, 4).join(':') + '::';
  }
  
  return ip;
}

async function loadConfig(env) {
  const now = Date.now();
  if (configCache && (now - configCache.fetchedAt) < CONFIG_CACHE_TTL_MS) {
    return configCache;
  }

  let limit = DEFAULT_RATE_LIMIT;
  let windowMinutes = DEFAULT_RATE_LIMIT_WINDOW_MINUTES;

  try {
    const [limitRaw, windowRaw] = await Promise.all([
      env.RATE_LIMIT.get(CONFIG_KEY_LIMIT),
      env.RATE_LIMIT.get(CONFIG_KEY_WINDOW_MINUTES),
    ]);

    const parsedLimit = limitRaw !== null ? Number(limitRaw) : NaN;
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) limit = parsedLimit;

    const parsedWindow = windowRaw !== null ? Number(windowRaw) : NaN;
    if (Number.isFinite(parsedWindow) && parsedWindow > 0) windowMinutes = parsedWindow;
  } catch (e) {
    // KV read error: fall back to defaults
  }

  configCache = { limit, windowMinutes, fetchedAt: now };
  return configCache;
}

async function safeKvPut(env, key, value, options) {
  try {
    await env.RATE_LIMIT.put(key, value, options);
  } catch (e) {
    console.error(`[hen] KV put failed for key ${key}: ${e.message}`);
  }
}

async function checkRateLimit(request, env, ctx) {

    const cfg = await loadConfig(env);
    const windowSeconds = cfg.windowMinutes * 60;

    const ip = getNormalizedIP(request);

    if (!ip) {
      return new Response("Unable to determine IP", { status: 400 });
    }

    const key = `rate_limit:${ip}`;
    const now = Math.floor(Date.now() / 1000);

    const cached = rateLimitCache.get(ip);

    if (cached && now <= cached.resetTime) {
      cached.count += 1;

      const shouldSync =
        cached.count === 2 ||
        now - cached.lastKvSync >= KV_SYNC_INTERVAL_SECONDS ||
        cached.count > cfg.limit;

      if (shouldSync) {
        cached.lastKvSync = now;
        ctx.waitUntil(safeKvPut(env, key, JSON.stringify({ count: cached.count, resetTime: cached.resetTime }), { expirationTtl: windowSeconds + 10 }));
      }
    } else {
      let data = null;
      try {
        data = await env.RATE_LIMIT.get(key, { type: 'json' });
      } catch (e) {
        // KV read error: fall back to in-memory defaults
      }

      if (data && now <= data.resetTime) {
        data.count += 1;
      } else {
        data = { count: 1, resetTime: now + windowSeconds };
      }

      rateLimitCache.set(ip, { count: data.count, resetTime: data.resetTime, lastKvSync: now });
      ctx.waitUntil(safeKvPut(env, key, JSON.stringify(data), { expirationTtl: windowSeconds + 10 }));
    }

    const entry = rateLimitCache.get(ip);

    if (entry.count > cfg.limit) {
      return new Response(`Rate limit exceeded (${cfg.limit} requests / ${cfg.windowMinutes} min).`, {
        status: 429,
        headers: {
          "Retry-After": String(windowSeconds),
          "Content-Type": "text/plain"
        }
      });
    }

    return null;
}

export default {
  async fetch(request, env, ctx) {

    if (env.LOG_REQUESTS === 'true') {
      console.log(`[hen] url=${request.url} ip=${getNormalizedIP(request) ?? 'unknown'}`);
    }

    const rateLimitResponse = await checkRateLimit(request,env,ctx);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }
    
    const url = new URL(request.url);
    const pathname = url.pathname; // e.g. /hen.19x19.b_16DbQw.png

    const lowerPath = pathname.toLowerCase();
    let isGif = false;
    if (lowerPath.endsWith('.png')) {
      isGif = false;
    } else if (lowerPath.endsWith('.gif')) {
      isGif = true;
    } else {
      return new Response('Not Found or Invalid Format', { status: 404 });
    }

    let henStartIndex = pathname.indexOf('/hen');
    if (henStartIndex === -1) {
      return new Response('Not Found or Invalid Format', { status: 404 });
    }

    let optionsStr = '';
    if (henStartIndex > 0) {
      optionsStr = pathname.substring(1, henStartIndex);
    }

    const showCoordinates = optionsStr.includes('c');
    const autoCrop = optionsStr.includes('x');

    const cache = caches.default;
    let cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;

    const henString = pathname.substring(henStartIndex + 4, pathname.length - 4);

    try {
      const renderResult = generateGobanSVG(henString, { showCoordinates, autoCrop, flat: isGif });
      const svgString = renderResult.svg;

      if (!wasmInitialized) {
        await initWasm(wasmModule);
        wasmInitialized = true;
      }

      const font = new Uint8Array(fontData);

      const resvg = new Resvg(svgString, {
        fitTo: { mode: 'width', value: renderResult.width },
        font: {
          fontBuffers: [font],   // provides the TTF font to Resvg
          defaultFontFamily: 'Roboto',
          serifFamilyType: 'Roboto',
          sansSerifFamilyType: 'Roboto',
          monspaceFamilyType: 'Roboto',
        },
      });

      let response;
      if (isGif) {
        const rendered = resvg.render();
        const rgba = rendered.pixels;
        const palette = quantize(rgba, 64, { format: 'rgba4444' });
        const index = applyPalette(rgba, palette, 'rgba4444');

        const gif = GIFEncoder();
        gif.writeFrame(index, rendered.width, rendered.height, { palette });
        gif.finish();

        let gifBytes = gif.bytes();
        gifBytes = insertGifComment(gifBytes, 'HEN', henString);
        gifBytes = insertGifComment(gifBytes, 'Software', 'hen-worker (c) 2026 hemme');

        response = new Response(gifBytes, {
          headers: {
            'Content-Type': 'image/gif',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      } else {
        let pngBuffer = resvg.render().asPng();
        pngBuffer = insertPngTextChunk(pngBuffer, 'HEN', henString);
        pngBuffer = insertPngTextChunk(pngBuffer, 'Software', 'hen-worker (c) 2026 hemme');

        response = new Response(pngBuffer, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }

      ctx.waitUntil(cache.put(request, response.clone()));

      return response;

    } catch (error) {
      return new Response(`Rendering error: ${error.message}`, { status: 400 });
    }
  }
};

// ─── Parsing HEN ──────────────────────────────────────────────────────────────

function henLetterToIndex(letter) {
  return HEN_LETTERS.indexOf(letter.toUpperCase());
}

function henStoneToColor(ch) {
  if (ch === 'b') return BLACK;
  if (ch === 'w') return WHITE;
  return EMPTY;
}

function parseHen(hen) {
  if (!hen) return null;
  hen = decodeURIComponent(hen).trim().replace(/[\s\n\r]+/g, '');

  var result = {
    size: 19,
    board: null,
    koPoint: null,
    lastMove: null,
    turn: null,
    labels: [],
    marks: [],
    numberedStones: [],
    playerOrder: null,
  };

  var i = 0;
  var len = hen.length;

  var firstDelim = hen.search(/[._~]/);
  if (firstDelim === -1) firstDelim = len;
  if (firstDelim > 0) {
    _parseHenDotPart(hen.slice(0, firstDelim), result);
    i = firstDelim;
  }

  while (i < len) {
    if (hen[i] === '.') {
      i++;
      var partStart = i;
      while (i < len) {
        if (hen[i] === '.' || hen[i] === '_') break;
        if (hen[i] === '~') {
          if (i + 1 < len && 'bwrglyp'.indexOf(hen[i + 1]) !== -1) break;
        }
        i++;
      }
      var part = hen.slice(partStart, i);
      _parseHenDotPart(part, result);
    } else if (hen[i] === '_') {
      i++;
      var rowStart = i;
      while (i < len) {
        if (hen[i] === '_' || hen[i] === '.') break;
        if (hen[i] === '~') {
          if (i + 1 < len && hen[i + 1] >= '0' && hen[i + 1] <= '9') {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      var rowPart = hen.slice(rowStart, i);
      _parseHenRow(rowPart, result);
    } else if (hen[i] === '~') {
      i++;
      var poStart = i;
      while (i < len && hen[i] !== '.' && hen[i] !== '_' && hen[i] !== '~') i++;
      var poPart = hen.slice(poStart, i);
      result.playerOrder = [];
      for (var pi = 0; pi < poPart.length; pi++) {
        if ('bwrglyp'.indexOf(poPart[pi]) !== -1) {
          result.playerOrder.push(poPart[pi]);
        }
      }
    } else {
      i++;
    }
  }

  if (!result.board) {
    result.board = Array(result.size).fill(null).map(function () {
      return Array(result.size).fill(EMPTY);
    });
  }

  if (result.numberedStones.length > 0) {
    var po = result.playerOrder || ['b', 'w'];
    result.numberedStones.forEach(function (ns) {
      var colorIdx = (ns.number - 1) % po.length;
      var stoneChar = po[colorIdx];
      result.board[ns.row][ns.col] = henStoneToColor(stoneChar);
    });
  }

  return result;
}

function _parseHenDotPart(part, result) {
  if (!part) return;

  var sizeMatch = part.match(/^(\d+)x(\d+)$/);
  if (sizeMatch) {
    result.size = Math.max(2, Math.min(parseInt(sizeMatch[1], 10), 100));
    if (!result.board) {
      result.board = Array(result.size).fill(null).map(function () {
        return Array(result.size).fill(EMPTY);
      });
    }
    return;
  }

  if (part === 'b' || part === 'w') {
    result.turn = part;
    return;
  }

  if (part.length >= 2 && part[0] === 'p') {
    var passStone = part[1];
    if (passStone === 'b' || passStone === 'w') {
      result.lastMove = { color: henStoneToColor(passStone), pass: true };
      return;
    }
  }

  var lastMoveMatch = part.match(/^([A-HJ-T])(\d+)([bw])$/);
  if (lastMoveMatch) {
    var col = henLetterToIndex(lastMoveMatch[1]);
    var row = result.size - parseInt(lastMoveMatch[2], 10);
    var stoneColor = henStoneToColor(lastMoveMatch[3]);
    result.lastMove = { row: row, col: col, color: stoneColor, pass: false };
    return;
  }

  var koMatch = part.match(/^([A-HJ-T])(\d+)$/);
  if (koMatch) {
    var koCol = henLetterToIndex(koMatch[1]);
    var koRow = result.size - parseInt(koMatch[2], 10);
    result.koPoint = { row: koRow, col: koCol };
    return;
  }

  var labelMarkMatch = part.match(/^([A-HJ-T])(\d+)-(.+)$/);
  if (labelMarkMatch) {
    var lmCol = henLetterToIndex(labelMarkMatch[1]);
    var lmRow = result.size - parseInt(labelMarkMatch[2], 10);
    var val = labelMarkMatch[3];
    if (val === 'CR' || val === 'SQ' || val === 'TR' || val === 'MA') {
      result.marks.push({ row: lmRow, col: lmCol, mark: val });
    } else {
      result.labels.push({ row: lmRow, col: lmCol, letter: val });
    }
  }
}

function _parseHenRow(part, result) {
  if (!part) return;

  var rowStart = 0;
  while (rowStart < part.length && part[rowStart] >= '0' && part[rowStart] <= '9') {
    rowStart++;
  }
  if (rowStart === 0) return;

  var rowNum = result.size - parseInt(part.slice(0, rowStart), 10);
  if (isNaN(rowNum) || rowNum < 0 || rowNum >= result.size) return;

  if (!result.board) {
    result.board = Array(result.size).fill(null).map(function () {
      return Array(result.size).fill(EMPTY);
    });
  }

  var j = rowStart;
  var col = -1;
  var prevStone = null;

  if (j < part.length && part[j] >= 'A' && part[j] <= 'T' && part[j] !== 'I') {
    col = henLetterToIndex(part[j]);
    j++;
  } else {
    col = 0;
  }

  while (j < part.length) {
    var ch = part[j];
    if (ch >= 'A' && ch <= 'T' && ch !== 'I') {
      col = henLetterToIndex(ch);
      j++;
    } else if (ch === 'b' || ch === 'w') {
      if (col < result.size) {
        result.board[rowNum][col] = henStoneToColor(ch);
      }
      prevStone = ch;
      col++;
      j++;
    } else if (ch >= '0' && ch <= '9' && prevStone) {
      var numStart = j;
      while (j < part.length && part[j] >= '0' && part[j] <= '9') j++;
      var count = parseInt(part.slice(numStart, j), 10);
      count = Math.min(count, result.size + 1);
      for (var k = 1; k < count; k++) {
        if (col < result.size) {
          result.board[rowNum][col] = henStoneToColor(prevStone);
        }
        col++;
      }
    } else if (ch === '~') {
      j++;
      var mvNumStart = j;
      while (j < part.length && part[j] >= '0' && part[j] <= '9') j++;
      var moveNum = parseInt(part.slice(mvNumStart, j), 10);
      if (!isNaN(moveNum) && moveNum > 0) {
        result.numberedStones.push({ row: rowNum, col: col, number: moveNum });
      }
      prevStone = null;
      col++;
    } else {
      j++;
    }
  }
}

// ─── SVG Generation ──────────────────────────────────────────────────────────

function calculateAutoCrop(pos) {
  var size = pos.size;
  var board = pos.board;
  var occupied = [];

  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY) {
        occupied.push({ row: r, col: c });
      }
    }
  }

  if (pos.marks) {
    pos.marks.forEach(function (m) { occupied.push({ row: m.row, col: m.col }); });
  }
  if (pos.labels) {
    pos.labels.forEach(function (l) { occupied.push({ row: l.row, col: l.col }); });
  }
  if (pos.numberedStones) {
    pos.numberedStones.forEach(function (ns) { occupied.push({ row: ns.row, col: ns.col }); });
  }
  if (pos.lastMove && !pos.lastMove.pass && pos.lastMove.row >= 0 && pos.lastMove.row < size && pos.lastMove.col >= 0 && pos.lastMove.col < size) {
    occupied.push({ row: pos.lastMove.row, col: pos.lastMove.col });
  }

  if (occupied.length === 0) return null;

  var minRow = size, maxRow = 0;
  var minCol = size, maxCol = 0;
  for (var i = 0; i < occupied.length; i++) {
    var r = occupied[i].row;
    var c = occupied[i].col;
    minRow = Math.min(minRow, r);
    maxRow = Math.max(maxRow, r);
    minCol = Math.min(minCol, c);
    maxCol = Math.max(maxCol, c);
  }

  var rowStart = Math.max(0, minRow - 2.5);
  var rowEnd = Math.min(size - 1, maxRow + 2.5);
  var colStart = Math.max(0, minCol - 2.5);
  var colEnd = Math.min(size - 1, maxCol + 2.5);

  var edge = Math.min(4, size - 1);
  function hasContent(rMin, rMax, cMin, cMax) {
    for (var i = 0; i < occupied.length; i++) {
      var r = occupied[i].row;
      var c = occupied[i].col;
      if (r >= rMin && r <= rMax && c >= cMin && c <= cMax) return true;
    }
    return false;
  }

  if (hasContent(0, edge, 0, edge)) {
    rowStart = 0; colStart = 0;
  }
  if (hasContent(0, edge, size - 1 - edge, size - 1)) {
    rowStart = 0; colEnd = size - 1;
  }
  if (hasContent(size - 1 - edge, size - 1, 0, edge)) {
    rowEnd = size - 1; colStart = 0;
  }
  if (hasContent(size - 1 - edge, size - 1, size - 1 - edge, size - 1)) {
    rowEnd = size - 1; colEnd = size - 1;
  }

  if (rowStart === 0 && rowEnd === size - 1 && colStart === 0 && colEnd === size - 1) {
    return null;
  }

  return { rowStart: rowStart, rowEnd: rowEnd, colStart: colStart, colEnd: colEnd };
}

// Helper: emits an SVG <text> element with Roboto font
function svgText(x, y, content, fontSize, fill, extraAttrs) {
  extraAttrs = extraAttrs || '';
  return '<text x="' + x + '" y="' + y + '"'
    + ' text-anchor="middle"'
    + ' dominant-baseline="central"'
    + ' font-family="Roboto, sans-serif"'
    + ' font-size="' + fontSize + '"'
    + ' fill="' + fill + '"'
    + extraAttrs
    + '>' + content + '</text>';
}

function generateGobanSVG(hen, options) {
  options = options || {};
  var pos = parseHen(hen);
  if (!pos || !pos.board) {
    return {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="#DCB35C"/></svg>',
      width: 1000,
      height: 1000
    };
  }

  var size = pos.size;
  var board = pos.board;
  var lastMove = pos.lastMove;
  var marks = pos.marks || [];
  var labels = pos.labels || [];
  var numberedStones = pos.numberedStones || [];

  // Scale everything by 10 to ensure text rendering doesn't hit small font limits
  var pad = options.showCoordinates ? 70 : 40;
  var boardArea = 1000 - pad * 2;
  var step = boardArea / (size - 1);
  var stoneR = step * 0.46;

  var crop = options.autoCrop ? calculateAutoCrop(pos) : null;
  var vbX = 0, vbY = 0, vbW = 1000, vbH = 1000;

  if (crop) {
    var xMin = crop.colStart === 0 ? 0 : pad + crop.colStart * step;
    var xMax = crop.colEnd === size - 1 ? 1000 : pad + crop.colEnd * step;
    var yMin = crop.rowStart === 0 ? 0 : pad + crop.rowStart * step;
    var yMax = crop.rowEnd === size - 1 ? 1000 : pad + crop.rowEnd * step;
    
    vbX = xMin;
    vbY = yMin;
    vbW = xMax - xMin;
    vbH = yMax - yMin;
  }

  var svg = '';
  svg += '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vbX + ' ' + vbY + ' ' + vbW + ' ' + vbH + '">';

  // Flat colors for GIF (no gradients); otherwise gradient definitions.
  var flat = options.flat;
  var boardFill = flat ? '#DCB35C' : 'url(#bg)';
  var blackFill = flat ? '#1a1a1a' : 'url(#bs)';
  var whiteFill = flat ? '#e8e4dc' : 'url(#ws)';

  if (!flat) {
    svg += '<defs>';
    svg += '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">';
    svg += '<stop offset="0%" stop-color="#DCB35C"/>';
    svg += '<stop offset="100%" stop-color="#B8963E"/>';
    svg += '</linearGradient>';
    svg += '<radialGradient id="bs" cx="35%" cy="30%" r="80%">';
    svg += '<stop offset="0%" stop-color="#4a4a4a"/>';
    svg += '<stop offset="50%" stop-color="#1a1a1a"/>';
    svg += '<stop offset="100%" stop-color="#0a0a0a"/>';
    svg += '</radialGradient>';
    svg += '<radialGradient id="ws" cx="35%" cy="30%" r="80%">';
    svg += '<stop offset="0%" stop-color="#ffffff"/>';
    svg += '<stop offset="40%" stop-color="#e8e4dc"/>';
    svg += '<stop offset="100%" stop-color="#c8c4bc"/>';
    svg += '</radialGradient>';
    svg += '</defs>';
  }

  svg += '<rect width="1000" height="1000" fill="' + boardFill + '"/>';

  // Create mask to clip the grid under labels
  var labels = pos.labels || [];
  var hasGridMask = false;
  labels.forEach(function (l) {
    if (!board[l.row] || board[l.row][l.col] === EMPTY) {
      hasGridMask = true;
    }
  });

  if (hasGridMask) {
    svg += '<defs>';
    svg += '<mask id="grid-mask">';
    svg += '<rect width="1000" height="1000" fill="white"/>';
    labels.forEach(function (l) {
      if (!board[l.row] || board[l.row][l.col] === EMPTY) {
        var lx = pad + l.col * step;
        var ly = pad + l.row * step;
        var len = l.letter.length;
        var fs = (step * 0.5) * (len > 4 ? 0.45 : len > 3 ? 0.55 : len > 2 ? 0.65 : len > 1 ? 0.8 : 1);
        var tw = (fs * 0.65) * len + step * 0.2;
        var th = fs + step * 0.2;
        svg += '<rect x="' + (lx - tw / 2) + '" y="' + (ly - th / 2) + '" width="' + tw + '" height="' + th + '" fill="black"/>';
      }
    });
    svg += '</mask>';
    svg += '</defs>';
    svg += '<g mask="url(#grid-mask)">';
  } else {
    svg += '<g>';
  }
  
  // Grid
  svg += '<g stroke="#3d2914" stroke-width="2.0" stroke-linecap="round">';
  for (var i = 0; i < size; i++) {
    var p = pad + i * step;
    svg += '<line x1="' + p + '" y1="' + pad + '" x2="' + p + '" y2="' + (1000 - pad) + '"/>';
    svg += '<line x1="' + pad + '" y1="' + p + '" x2="' + (1000 - pad) + '" y2="' + p + '"/>';
  }
  svg += '</g>';

  svg += '<rect x="' + pad + '" y="' + pad + '" width="' + (1000 - pad * 2) + '" height="' + (1000 - pad * 2) + '" fill="none" stroke="#3d2914" stroke-width="5.0"/>';

  // Star points
  var starPts = STAR_POINTS[size] || [];
  starPts.forEach(function (pt) {
    var cx = pad + pt[1] * step;
    var cy = pad + pt[0] * step;
    var r = Math.max(4, Math.min(10, step * 0.19));
    svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="#3d2914"/>';
  });
  svg += '</g>';

  // ── Coordinates (now uses <text> with Roboto) ──────────────────────────────
  if (options.showCoordinates) {
    var fontSize = Math.max(15, Math.min(35, step * 0.45));
    var letterSpace = 'ABCDEFGHJKLMNOPQRST';
    var coordColor = '#3d2914';
    var fontWeight = ' font-weight="700"';

    // Column letters (top and bottom)
    for (var ci = 0; ci < size; ci++) {
      var cx = pad + ci * step;
      svg += svgText(cx, pad - 37, letterSpace[ci], fontSize, coordColor, fontWeight);
      svg += svgText(cx, 1000 - pad + 38, letterSpace[ci], fontSize, coordColor, fontWeight);
    }

    // Row numbers (left and right)
    for (var ri = 0; ri < size; ri++) {
      var cy = pad + ri * step;
      svg += svgText(pad - 40, cy, size - ri, fontSize, coordColor, fontWeight);
      svg += svgText(1000 - pad + 42, cy, size - ri, fontSize, coordColor, fontWeight);
    }
  }

  // Stones
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] === EMPTY) continue;
      var sx = pad + c * step;
      var sy = pad + r * step;
      var isBlack = board[r][c] === BLACK;

      svg += '<circle cx="' + sx + '" cy="' + sy + '" r="' + stoneR + '"';
      if (isBlack) {
        svg += ' fill="' + blackFill + '"/>';
      } else {
        svg += ' fill="' + whiteFill + '"/>';
      }
    }
  }

  // Last move marker
  if (lastMove && !lastMove.pass && lastMove.row >= 0 && lastMove.row < size && lastMove.col >= 0 && lastMove.col < size) {
    var hasLabelOnLastMove = labels.some(function(l) { return l.row === lastMove.row && l.col === lastMove.col; }) ||
                             numberedStones.some(function(ns) { return ns.row === lastMove.row && ns.col === lastMove.col; }) ||
                             marks.some(function(m) { return m.row === lastMove.row && m.col === lastMove.col; });
    if (!hasLabelOnLastMove) {
      var lmx = pad + lastMove.col * step;
      var lmy = pad + lastMove.row * step;
      var isBlackLast = board[lastMove.row][lastMove.col] === BLACK;
      var markStroke = isBlackLast ? '#FFFFFF' : '#3D2914';
      svg += '<circle cx="' + lmx + '" cy="' + lmy + '" r="' + (step * 0.3) + '" fill="none" stroke="' + markStroke + '" stroke-width="' + (step * 0.03) + '"/>';
    }
  }

  // Marks (CR, SQ, TR, MA)
  marks.forEach(function (m) {
    var mx = pad + m.col * step;
    var my = pad + m.row * step;
    var isBlackCell = board[m.row] && board[m.row][m.col] === BLACK;
    var sc = isBlackCell ? '#FFFFFF' : '#3D2914';
    var sw = step * 0.08;

    if (m.mark === 'CR') {
      var crSc = isBlackCell ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)';
      svg += '<circle cx="' + mx + '" cy="' + my + '" r="' + (stoneR * 0.45) + '" fill="none" stroke="' + crSc + '" stroke-width="' + (stoneR * 0.15) + '"/>';
    } else if (m.mark === 'SQ') {
      var sqS = step * 0.22;
      svg += '<rect x="' + (mx - sqS) + '" y="' + (my - sqS) + '" width="' + (sqS * 2) + '" height="' + (sqS * 2) + '" fill="none" stroke="' + sc + '" stroke-width="' + sw + '"/>';
    } else if (m.mark === 'TR') {
      var trH = step * 0.32;
      svg += '<polygon points="' + mx + ',' + (my - trH) + ' ' + (mx + trH * 0.866) + ',' + (my + trH * 0.5) + ' ' + (mx - trH * 0.866) + ',' + (my + trH * 0.5) + '" fill="none" stroke="' + sc + '" stroke-width="' + sw + '" stroke-linejoin="round"/>';
    } else if (m.mark === 'MA') {
      var xS = step * 0.22;
      svg += '<line x1="' + (mx - xS) + '" y1="' + (my - xS) + '" x2="' + (mx + xS) + '" y2="' + (my + xS) + '" stroke="' + sc + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
      svg += '<line x1="' + (mx + xS) + '" y1="' + (my - xS) + '" x2="' + (mx - xS) + '" y2="' + (my + xS) + '" stroke="' + sc + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
    }
  });

  // Labels on stones (uses <text> with Roboto)
  var annTextSize = step * 0.5;
  labels.forEach(function (l) {
    var lx = pad + l.col * step;
    var ly = pad + l.row * step;
    var isBlackCell = board[l.row] && board[l.row][l.col] === BLACK;
    var fillC = isBlackCell ? '#FFFFFF' : '#3D2914';
    var len = l.letter.length;
    var fs = annTextSize * (len > 4 ? 0.45 : len > 3 ? 0.55 : len > 2 ? 0.65 : len > 1 ? 0.8 : 1);
    svg += svgText(lx, ly, l.letter, fs, fillC, ' font-weight="700"');
  });

  // Numbers on stones (uses <text> with Roboto)
  numberedStones.forEach(function (ns) {
    var nx = pad + ns.col * step;
    var ny = pad + ns.row * step;
    var isBlackCell = board[ns.row] && board[ns.row][ns.col] === BLACK;
    var fillC = isBlackCell ? '#FFFFFF' : '#3D2914';
    var fs = annTextSize * (ns.number >= 100 ? 0.5 : ns.number >= 10 ? 0.65 : 0.8);
    svg += svgText(nx, ny, ns.number, fs, fillC, ' font-weight="700"');
  });

  svg += '</svg>';
  return { svg: svg, width: Math.round(vbW), height: Math.round(vbH) };
}
