#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_svg="$project_root/assets/icon.svg"
iconset_dir="$project_root/assets/icon.iconset"
output_icns="$project_root/assets/icon.icns"
output_png="$project_root/assets/icon.png"

rm -rf "$iconset_dir"
mkdir -p "$iconset_dir"

rsvg-convert --width 1024 --height 1024 "$source_svg" > "$output_png"
cp "$output_png" "$iconset_dir/icon_512x512@2x.png"

for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$iconset_dir/icon_512x512@2x.png" --out "$iconset_dir/icon_${size}x${size}.png" >/dev/null
    double_size=$((size * 2))
    sips -z "$double_size" "$double_size" "$iconset_dir/icon_512x512@2x.png" --out "$iconset_dir/icon_${size}x${size}@2x.png" >/dev/null
done

if ! iconutil -c icns "$iconset_dir" -o "$output_icns" 2>/dev/null; then
    node "$project_root/scripts/write-icns.js" "$iconset_dir" "$output_icns"
fi
