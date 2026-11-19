#!/bin/zsh
# render.sh <cut-folder> <port> <scratch-dir> : 16:9 + 1:1 frames -> brag-newlogo.mp4 / brag-1x1-newlogo.mp4 (+ jpg posters)
set -e
CUT=$1; PORT=$2; S=$3; cd ${0:a:h}/$CUT/work
node stage/start.mjs > $S/stage.log 2>&1 & SRV=$!; sleep 3
trap "kill $SRV 2>/dev/null" EXIT
node capture.mjs $S/frames all; FMT=square node capture.mjs $S/sqframes all
for pair in "frames:brag-newlogo" "sqframes:brag-1x1-newlogo"; do
  d=${pair%%:*}; o=${pair##*:}
  ffmpeg -v error -y -framerate 30 -i $S/$d/f%04d.png -i music.wav -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow -c:a aac -b:a 192k -shortest ../$o.mp4
  ffmpeg -v error -y -ss 19.5 -i ../$o.mp4 -frames:v 1 -q:v 3 ../$o.jpg
  printf "%s " $o; ffprobe -v error -show_entries format=duration:stream=width,height -of csv=p=0 ../$o.mp4 | tr '\n' ' '
  ffmpeg -hide_banner -i ../$o.mp4 -vf freezedetect=n=0.003:d=0.8 -map 0:v -f null - 2>&1 | grep -o "freeze_start: [0-9.]*" | tr '\n' ' '; echo
done
