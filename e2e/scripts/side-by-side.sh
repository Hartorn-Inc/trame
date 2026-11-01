#!/usr/bin/env sh
# Combines artifacts/gm.webm (left) and artifacts/player.webm (right) into one
# labelled H.264 MP4 using a pinned ffmpeg image (no host ffmpeg required).
# Usage: sh e2e/scripts/side-by-side.sh [artifacts-dir]
set -eu
dir="$(cd "${1:-$(dirname "$0")/../artifacts}" && pwd)"
label='drawtext=text=%s:x=16:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8'
docker run --rm -v "$dir":/work -w /work linuxserver/ffmpeg:9.0.2 -y -loglevel error \
  -i gm.webm -i player.webm \
  -filter_complex "[0:v]scale=960:600,setsar=1,$(printf "$label" 'GM')[l];[1:v]scale=960:600,setsar=1,$(printf "$label" 'PLAYER')[r];[l][r]hstack=inputs=2,format=yuv420p[v]" \
  -map '[v]' -c:v libx264 -preset medium -crf 23 -movflags +faststart -shortest \
  gm-player-side-by-side.mp4
echo "$dir/gm-player-side-by-side.mp4"
