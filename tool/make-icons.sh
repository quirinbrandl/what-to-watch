#!/bin/zsh
# Draws the logo (WTW in the title font, the T in the accent colour) and writes
# the app icon and splash image in every size Expo and Android need.
# Needs Google Chrome and ImageMagick. Run from the repository root:
#   tool/make-icons.sh
set -e
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FONT=node_modules/@expo-google-fonts/anton/400Regular/Anton_400Regular.ttf
RES=android/app/src/main/res
OUT=assets/icon
TMP=$(mktemp -d)

# One page draws every variant; ?v= picks it. Sizes are in units of a 100 x 100 tile.
cat > $TMP/logo.html <<HTML
<!doctype html><meta charset="utf-8">
<style>
@font-face { font-family: Anton; src: url(data:font/ttf;base64,$(base64 -i $FONT)); }
html, body { margin: 0; background: transparent; }
svg { display: block; width: 100vw; height: 100vw; }
</style>
<body><script>
const V = {
  icon:     { scale: 1,       tile: '#0B0B0E', w: '#FFFFFF', t: '#FF4D2E' }, // the whole tile
  fg:       { scale: 72 / 108,                 w: '#FFFFFF', t: '#FF4D2E' }, // adaptive icon: the launcher shows the middle two thirds
  mono:     { scale: 72 / 108,                 w: 'rgba(255,255,255,.6)', t: '#FFFFFF' }, // themed icon: only the alpha counts
  splash:   { scale: 1.16,                     w: '#FFFFFF', t: '#FF4D2E' }, // the letters alone, edge to edge
  splash12: { scale: 0.74,                     w: '#FFFFFF', t: '#FF4D2E' }, // Android 12+: must fit a circle two thirds wide
}[new URLSearchParams(location.search).get('v')];
document.fonts.load('100px Anton').then(() => {
  const c = document.createElement('canvas').getContext('2d');
  c.font = '100px Anton';
  const m = c.measureText('WTW');
  // Fit the ink of the letters into a 72 x 46 box and centre it on the tile.
  const k = Math.min(72 / (m.actualBoundingBoxLeft + m.actualBoundingBoxRight), 46 / (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent));
  const x = 50 - ((m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2) * k;
  const y = 50 + ((m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2) * k;
  document.body.innerHTML = '<svg viewBox="0 0 100 100">' + (V.tile ? '<rect width="100" height="100" fill="' + V.tile + '"/>' : '') +
    '<g transform="translate(50 50) scale(' + V.scale + ') translate(-50 -50)"><text x="' + x + '" y="' + y + '" font-size="' + k * 100 + '" font-family="Anton" fill="' + V.w + '">W<tspan fill="' + V.t + '">T</tspan>W</text></g></svg>';
});
</script>
HTML

shot() { # variant, pixels
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size=$2,$2 --virtual-time-budget=4000 --screenshot=$TMP/$1.png "file://$TMP/logo.html?v=$1" 2>/dev/null
}
shot icon 1024; shot fg 1024; shot mono 1024; shot splash 1152; shot splash12 1152

cp $TMP/icon.png $OUT/icon.png
cp $TMP/fg.png $OUT/icon_fg.png
cp $TMP/mono.png $OUT/icon_mono.png
magick $TMP/splash.png -resize 768x768 $OUT/splash.png
cp $TMP/splash12.png $OUT/splash12.png

# Android versions before adaptive icons get the whole tile, square and cut to a circle.
cp $TMP/icon.png $TMP/legacy.png
magick $TMP/icon.png -alpha set \( -size 1024x1024 xc:none -fill white -draw 'circle 512,512 512,0' \) -compose DstIn -composite $TMP/round.png
webp() { magick $1 -resize $2x$2 -define webp:lossless=true $3 }
for d in mdpi:48:108:288 hdpi:72:162:432 xhdpi:96:216:576 xxhdpi:144:324:864 xxxhdpi:192:432:1152; do
  p=(${(s/:/)d})
  webp $TMP/legacy.png $p[2] $RES/mipmap-$p[1]/ic_launcher.webp
  webp $TMP/round.png $p[2] $RES/mipmap-$p[1]/ic_launcher_round.webp
  webp $TMP/fg.png $p[3] $RES/mipmap-$p[1]/ic_launcher_foreground.webp
  webp $TMP/mono.png $p[3] $RES/mipmap-$p[1]/ic_launcher_monochrome.webp
  magick $TMP/splash12.png -resize $p[4]x$p[4] $RES/drawable-$p[1]/splashscreen_logo.png
done
rm -rf $TMP
echo "icons written"
