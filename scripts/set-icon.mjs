#!/usr/bin/env node
// Picks the first existing icon file in media/ (jpg > jpeg > png > svg)
// and updates package.json so the activity bar / view icon points to it.
//
// Usage:  npm run set-icon
//
// Drop any of these into the media/ folder and re-run this script:
//   media/icon.svg
//   media/icon.png
//   media/icon.jpg
//   media/icon.jpeg
//
// Note: VS Code's activity bar prefers a monochrome SVG (it auto-tints based
// on the theme). PNG/JPG will still be displayed, but they will appear as-is
// without theme-aware tinting.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkgPath = resolve(root, 'package.json');

const candidates = ['icon.jpg', 'icon.jpeg', 'icon.png', 'icon.svg'];
const chosen = candidates.find((name) => existsSync(resolve(root, 'media', name)));

if (!chosen) {
  console.error(
    'No icon found. Place one of media/icon.svg, media/icon.png, media/icon.jpg, media/icon.jpeg.'
  );
  process.exit(1);
}

const iconPath = `media/${chosen}`;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

let changed = false;

// Activity bar container
if (pkg?.contributes?.viewsContainers?.activitybar?.length) {
  for (const c of pkg.contributes.viewsContainers.activitybar) {
    if (c.id === 'yamakawaCode' && c.icon !== iconPath) {
      c.icon = iconPath;
      changed = true;
    }
  }
}

// View icon
if (pkg?.contributes?.views?.yamakawaCode?.length) {
  for (const v of pkg.contributes.views.yamakawaCode) {
    if (v.id === 'yamakawaCode.chatView' && v.icon !== iconPath) {
      v.icon = iconPath;
      changed = true;
    }
  }
}

// Extension icon (shown in the marketplace) — only set if raster
if (chosen.endsWith('.png') || chosen.endsWith('.jpg') || chosen.endsWith('.jpeg')) {
  if (pkg.icon !== iconPath) {
    pkg.icon = iconPath;
    changed = true;
  }
}

if (changed) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Icon set to ${iconPath} (package.json updated).`);
} else {
  console.log(`Icon already set to ${iconPath}. No changes.`);
}
