'use strict';

const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const sharp = require('sharp');

const ROOT = resolve(__dirname, '..');
const SOURCE = join(ROOT, 'build', 'icon.png');
const RES = join(ROOT, 'mobile', 'android-bridge', 'app', 'src', 'main', 'res');
const BRAND_BACKGROUND = { r: 7, g: 19, b: 43, alpha: 1 };
const DENSITIES = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

function roundedRectSvg(size, radius, circle = false) {
  const shape = circle
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>`
    : `<rect width="${size}" height="${size}" rx="${radius}" fill="white"/>`;
  return Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">${shape}</svg>`);
}

async function trimmedLogo() {
  return sharp(SOURCE)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function logoLayer(logo, size, scale) {
  const target = Math.round(size * scale);
  return sharp(logo)
    .resize(target, target, { fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
}

async function legacyIcon(logo, size, round) {
  const mark = await logoLayer(logo, size, 0.70);
  const markMeta = await sharp(mark).metadata();
  const canvas = await sharp({
    create: { width: size, height: size, channels: 4, background: BRAND_BACKGROUND },
  })
    .composite([{
      input: mark,
      left: Math.round((size - markMeta.width) / 2),
      top: Math.round((size - markMeta.height) / 2),
    }])
    .png()
    .toBuffer();

  return sharp(canvas)
    .composite([{ input: roundedRectSvg(size, Math.round(size * 0.22), round), blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function adaptiveLayers(logo) {
  // Adaptive icons use a 108 dp canvas. Keeping the mark inside the central
  // 66 dp safe zone prevents OEM launcher masks from cropping the logo.
  const size = 432;
  const mark = await logoLayer(logo, size, 0.60);
  const markMeta = await sharp(mark).metadata();
  const left = Math.round((size - markMeta.width) / 2);
  const top = Math.round((size - markMeta.height) / 2);
  const foreground = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: mark, left, top }]).png().toBuffer();

  const monochromeMark = await sharp({
    create: {
      width: markMeta.width,
      height: markMeta.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).composite([{ input: mark, blend: 'dest-in' }]).png().toBuffer();
  const monochrome = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: monochromeMark, left, top }]).png().toBuffer();

  return { foreground, monochrome };
}

async function main() {
  const logo = await trimmedLogo();
  for (const [density, size] of Object.entries(DENSITIES)) {
    const dir = join(RES, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    await sharp(await legacyIcon(logo, size, false)).toFile(join(dir, 'ic_launcher.png'));
    await sharp(await legacyIcon(logo, size, true)).toFile(join(dir, 'ic_launcher_round.png'));
  }

  const drawable = join(RES, 'drawable-nodpi');
  mkdirSync(drawable, { recursive: true });
  const { foreground, monochrome } = await adaptiveLayers(logo);
  await sharp(foreground).toFile(join(drawable, 'ic_launcher_foreground.png'));
  await sharp(monochrome).toFile(join(drawable, 'ic_launcher_monochrome.png'));
  process.stdout.write('Generated OPC-Nexus Android launcher icons.\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
