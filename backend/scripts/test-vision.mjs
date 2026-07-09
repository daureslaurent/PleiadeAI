// Isolate the Vision endpoint from PleiadesAI: sends ONE image straight to the configured vision
// endpoint's /v1/chat/completions and prints the raw response (content, finish_reason, token usage).
// If this returns garbage too, the problem is the endpoint/model/mmproj — not the app.
//
// Usage:
//   node scripts/test-vision.mjs                 # test image = a generated shapes PNG
//   node scripts/test-vision.mjs --image foo.png # test your own image
//   API_URL=http://localhost:4000 AUTH_USERNAME=admin AUTH_PASSWORD=change-me node scripts/test-vision.mjs
//
// It reads the *live* Settings → Vision endpoint + model, so it tests exactly what the app uses.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const API = process.env.API_URL || 'http://localhost:4000';
const USER = process.env.AUTH_USERNAME || 'admin';
const PASS = process.env.AUTH_PASSWORD || 'change-me';
const imgArg = process.argv.indexOf('--image');

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
/** Build a small RGB PNG with a few labelled colour blocks so "describe this" has real content. */
function makeTestPng(w = 480, h = 320) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3); // filter byte 0 + RGB
    for (let x = 0; x < w; x++) {
      let r = 230, g = 230, b = 235; // light-gray background
      if (x < w / 2 && y < h / 2) [r, g, b] = [220, 40, 40]; // red top-left
      else if (x >= w / 2 && y >= h / 2) [r, g, b] = [40, 90, 220]; // blue bottom-right
      else if (y > h / 3 && y < (2 * h) / 3) [r, g, b] = [40, 170, 80]; // green band
      const o = 1 + x * 3;
      row[o] = r; row[o + 1] = g; row[o + 2] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { token } = await login.json();
  const auth = { Authorization: `Bearer ${token}` };

  const settings = await (await fetch(`${API}/api/settings`, { headers: auth })).json();
  const endpoints = await (await fetch(`${API}/api/endpoints`, { headers: auth })).json();
  const ep = endpoints.find((e) => e._id === settings.vision_endpoint_id);
  if (!ep) throw new Error('No Vision endpoint configured (Settings → Vision endpoint).');
  const model = settings.vision_model || ep.default_model || ep.models?.[0];
  console.log(`Vision endpoint: ${ep.name} @ ${ep.base_url}`);
  console.log(`Model: ${model}   supports_vision flag: ${ep.supports_vision}`);

  const bytes = imgArg > -1 ? readFileSync(process.argv[imgArg + 1]) : makeTestPng();
  const mime = imgArg > -1 && process.argv[imgArg + 1].endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
  console.log(`Image: ${imgArg > -1 ? process.argv[imgArg + 1] : 'generated shapes PNG'} (${bytes.length} bytes)\n`);

  const res = await fetch(`${ep.base_url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.api_key || 'x'}` },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that looks at images and answers accurately.' },
        {
          role: 'user',
          // Image-first, then text — matches the app and Qwen2.5-VL's training convention.
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: 'Describe this image in one or two sentences. What colours and shapes do you see?' },
          ],
        },
      ],
    }),
  });
  const raw = await res.text();
  console.log(`HTTP ${res.status}`);
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    console.log('Non-JSON response:', raw.slice(0, 500));
    return;
  }
  const choice = json.choices?.[0];
  console.log('finish_reason:', choice?.finish_reason);
  console.log('usage:', JSON.stringify(json.usage));
  console.log('\n--- model answer ---');
  console.log(choice?.message?.content ?? '(no content)');
  console.log('--------------------');
  console.log(
    '\nExpected: a coherent sentence about red/green/blue shapes. Garbage/near-empty ⇒ the endpoint' +
      " isn't integrating the image (wrong/mismatched --mmproj for this model, or not a VL model).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
