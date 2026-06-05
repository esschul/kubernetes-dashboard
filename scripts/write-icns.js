const fs = require('node:fs');
const path = require('node:path');

const [iconsetDir, outputFile] = process.argv.slice(2);

if (!iconsetDir || !outputFile) {
    console.error('Usage: node scripts/write-icns.js <iconset-dir> <output.icns>');
    process.exit(1);
}

const entries = [
    ['icp4', 'icon_16x16.png'],
    ['icp5', 'icon_32x32.png'],
    ['icp6', 'icon_32x32@2x.png'],
    ['ic07', 'icon_128x128.png'],
    ['ic08', 'icon_256x256.png'],
    ['ic09', 'icon_512x512.png'],
    ['ic10', 'icon_512x512@2x.png'],
];

function iconEntry(type, fileName) {
    const png = fs.readFileSync(path.join(iconsetDir, fileName));
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + header.length, 4);
    return Buffer.concat([header, png]);
}

const chunks = entries.map(([type, fileName]) => iconEntry(type, fileName));
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(header.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);

fs.writeFileSync(outputFile, Buffer.concat([header, ...chunks]));
