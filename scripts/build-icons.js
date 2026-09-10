#!/usr/bin/env node
// Cross-platform replacement for build-mac-icon.sh, which relied on macOS-only
// `sips`/`iconutil`. Uses sharp for resizing (works on any OS) and reuses
// write-icns.js — the only part of the old chain that already ran off-macOS —
// to hand-write the .icns container.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');

const projectRoot = path.join(__dirname, '..');
const sourceSvg = path.join(projectRoot, 'assets', 'icon.svg');
const iconsetDir = path.join(projectRoot, 'assets', 'icon.iconset');
const outputIcns = path.join(projectRoot, 'assets', 'icon.icns');
const outputPng = path.join(projectRoot, 'assets', 'icon.png');

// Sizes needed inside the .iconset for write-icns.js (which expects these
// exact filenames) plus the intermediate doubled sizes for @2x variants.
const ICNS_SIZES = [16, 32, 128, 256, 512];

async function main() {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
    fs.mkdirSync(iconsetDir, { recursive: true });

    const master = await sharp(sourceSvg, { density: 384 }).resize(1024, 1024).png().toBuffer();
    fs.writeFileSync(outputPng, master);
    fs.writeFileSync(path.join(iconsetDir, 'icon_512x512@2x.png'), master);

    for (const size of ICNS_SIZES) {
        await sharp(master).resize(size, size).png().toFile(path.join(iconsetDir, `icon_${size}x${size}.png`));
        const doubleSize = size * 2;
        await sharp(master).resize(doubleSize, doubleSize).png().toFile(path.join(iconsetDir, `icon_${size}x${size}@2x.png`));
    }

    execFileSync(process.execPath, [path.join(__dirname, 'write-icns.js'), iconsetDir, outputIcns], { stdio: 'inherit' });

    console.log(`✓ Wrote ${path.relative(projectRoot, outputPng)} and ${path.relative(projectRoot, outputIcns)}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
