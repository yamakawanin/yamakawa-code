#!/usr/bin/env node
// Picks the first existing icon file in media/ (jpg > jpeg > png > svg).
// Activity bar/view icons ALWAYS prefer media/icon.svg (monochrome SVG),
// because VS Code renders that reliably. Raster files are still used for the
// package icon and for the in-webview logo.
//
// Usage:  npm run set-icon
//
// Drop any of these into the media/ folder and re-run this script:
//   media/icon.svg
//   media/icon.png
//   media/icon.jpg
//   media/icon.jpeg
//
// Note: Wrapping jpg/png into an SVG <image> can appear as a black blob in the
// activity bar. So we keep activity/view bound to icon.svg whenever possible.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkgPath = resolve(root, 'package.json');
const mediaDir = resolve(root, 'media');
const autoSvgName = 'icon.auto.svg';

const candidates = ['icon.jpg', 'icon.jpeg', 'icon.png', 'icon.svg'];
const chosen = candidates.find((name) => existsSync(resolve(mediaDir, name)));

if (!chosen) {
  console.error(
    'No icon found. Place one of media/icon.svg, media/icon.png, media/icon.jpg, media/icon.jpeg.'
  );
  process.exit(1);
}

const iconPath = `media/${chosen}`;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const isRaster = chosen.endsWith('.png') || chosen.endsWith('.jpg') || chosen.endsWith('.jpeg');

let changed = false;
let generatedSvg = false;

function mimeFromFile(name) {
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function buildWrappedSvg(dataUri) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">',
    '  <rect width="24" height="24" rx="4" fill="none"/>',
    `  <image href="${dataUri}" x="0" y="0" width="24" height="24" preserveAspectRatio="xMidYMid slice"/>`,
    '</svg>',
    ''
  ].join('\n');
}

const hasMonoSvg = existsSync(resolve(mediaDir, 'icon.svg'));
let activityIconPath = hasMonoSvg ? 'media/icon.svg' : iconPath;
if (isRaster) {
  const raw = readFileSync(resolve(mediaDir, chosen));
  const dataUri = `data:${mimeFromFile(chosen)};base64,${raw.toString('base64')}`;
  const wrappedSvg = buildWrappedSvg(dataUri);
  const autoSvgPath = resolve(mediaDir, autoSvgName);
  const prev = existsSync(autoSvgPath) ? readFileSync(autoSvgPath, 'utf8') : '';
  if (prev !== wrappedSvg) {
    writeFileSync(autoSvgPath, wrappedSvg, 'utf8');
    generatedSvg = true;
  }
  // Keep generated file for optional fallback/debug, but do not force it as
  // activity icon when icon.svg exists.
  if (!hasMonoSvg) {
    activityIconPath = `media/${autoSvgName}`;
  }
}

// Activity bar container
if (pkg?.contributes?.viewsContainers?.activitybar?.length) {
  for (const c of pkg.contributes.viewsContainers.activitybar) {
    if (c.id === 'yamakawaCode' && c.icon !== activityIconPath) {
      c.icon = activityIconPath;
      changed = true;
    }
  }
}

// View icon
if (pkg?.contributes?.views?.yamakawaCode?.length) {
  for (const v of pkg.contributes.views.yamakawaCode) {
    if (v.id === 'yamakawaCode.chatView' && v.icon !== activityIconPath) {
      v.icon = activityIconPath;
      changed = true;
    }
  }
}

// Extension icon (shown in the marketplace) — only set if raster
if (isRaster) {
  if (pkg.icon !== iconPath) {
    pkg.icon = iconPath;
    changed = true;
  }
}

if (changed) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Icon set to ${iconPath}; activity icons -> ${activityIconPath} (package.json updated).`);
} else {
  console.log(`Icon already set (package: ${iconPath}, activity: ${activityIconPath}). No changes.`);
}

if (generatedSvg) {
  console.log(`Generated media/${autoSvgName} from ${chosen}.`);
}

if (hasMonoSvg) {
  console.log('Activity/view icons are pinned to media/icon.svg for proper VS Code rendering.');
}
