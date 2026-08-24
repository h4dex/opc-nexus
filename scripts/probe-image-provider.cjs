'use strict';

// Narrow diagnostic: read the encrypted Provider from a copied Electron
// user-data directory and call its real images API once. This deliberately
// does not report Hermes success; it only separates Provider capability from
// Hermes inference availability.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const seedUserData = (process.env.AIBOX_ACCEPTANCE_SEED_USER_DATA || '').trim();
const outputRoot = path.resolve(process.env.AIBOX_IMAGE_OUTPUT || path.join(process.cwd(), 'tmp', 'image-provider-probe'));
if (seedUserData) app.setPath('userData', seedUserData);

function jsonResponse(data) {
  return JSON.stringify(data, null, 2);
}

async function main() {
  await app.whenReady();
  const report = { status: 'BLOCKED', startedAt: new Date().toISOString(), outputRoot };
  try {
    const dbFile = path.join(app.getPath('userData'), 'aibox-data', 'aibox.db');
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs({ locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file) });
    const database = new SQL.Database(fs.readFileSync(dbFile));
    const providerRows = database.exec('SELECT id, base_url, model, api_key_ref FROM providers ORDER BY is_default DESC, created_at LIMIT 1');
    if (!providerRows[0]?.values?.[0]) throw new Error('No Provider row found');
    const [providerId, baseUrl, configuredModel, keyRef] = providerRows[0].values[0];
    const secretRows = database.exec(`SELECT value_json FROM settings WHERE key = ${JSON.stringify(String(keyRef))}`);
    const encoded = secretRows[0]?.values?.[0]?.[0];
    if (typeof encoded !== 'string' || !safeStorage.isEncryptionAvailable()) throw new Error('Provider secret is unavailable to Electron safeStorage');
    const key = safeStorage.decryptString(Buffer.from(encoded, 'base64')).trim();
    const endpointBase = String(baseUrl).replace(/\/+$/, '') + (new URL(String(baseUrl)).pathname === '/' ? '/v1' : '');
    const model = process.env.AIBOX_IMAGE_MODEL || 'gpt-image-2';
    report.provider = { id: String(providerId), baseUrl: String(baseUrl), configuredModel: String(configuredModel), imageModel: model };
    const requestBody = {
      model,
      prompt: '高级黑色电动剃须刀，纯白背景，正面产品摄影，完整无遮挡，电商主图，不要文字水印。',
      size: '1024x1024',
      n: 1,
    };
    if (!/^gpt-image-/i.test(model)) requestBody.response_format = 'b64_json';
    const response = await fetch(`${endpointBase}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(300_000)
    });
    const payload = await response.json().catch(() => null);
    report.httpStatus = response.status;
    if (!response.ok) {
      report.error = payload?.error?.message || `HTTP ${response.status}`;
    } else if (!Array.isArray(payload?.data) || payload.data.length === 0) {
      report.error = 'Provider returned no image data';
    } else {
      const entry = payload.data[0];
      let bytes;
      let extension = '.png';
      if (typeof entry?.b64_json === 'string') bytes = Buffer.from(entry.b64_json, 'base64');
      else if (typeof entry?.url === 'string') {
        const imageResponse = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
        bytes = Buffer.from(await imageResponse.arrayBuffer());
        extension = imageResponse.headers.get('content-type')?.includes('jpeg') ? '.jpg' : extension;
      }
      if (!bytes?.length) throw new Error('Provider returned neither b64_json nor url');
      fs.mkdirSync(outputRoot, { recursive: true });
      const output = path.join(outputRoot, `provider-shaver-main${extension}`);
      fs.writeFileSync(output, bytes);
      report.status = 'PASS';
      report.output = {
        relativePath: path.relative(process.cwd(), output).replaceAll('\\', '/'),
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      };
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'report.json'), jsonResponse(report), 'utf8');
    process.stdout.write(`${jsonResponse(report)}\n`);
    app.quit();
  }
}

main().catch((error) => { process.stderr.write(`${error}\n`); app.quit(); process.exitCode = 1; });
