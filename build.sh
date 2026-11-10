#!/bin/bash
# Wraps src/game.html (page body) into a full standalone document at site/index.html.
set -e
cd "$(dirname "$0")"
# the build id (a hash of the source) is stamped into the page and into site/version.txt, so an open page can tell that a newer build is live
ID=$(sha1sum src/game.html | cut -c1-12)
{
  printf '<!doctype html>\n<html lang="hr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="description" content="Vijuga: igra zmija za do 6 igrača. Skreći, preskači tragove, ostani zadnji živ.">\n<meta property="og:type" content="website">\n<meta property="og:site_name" content="Vijuga">\n<meta property="og:title" content="Vijuga: igraj sa mnom">\n<meta property="og:description" content="Zmije, skokovi i power-upovi. Igraj s prijateljima u pregledniku i na mobitelu. Besplatno, 500 zlatnika za početak.">\n<meta property="og:url" content="https://zmijica.onrender.com/">\n<meta property="og:image" content="https://zmijica.onrender.com/og.png">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="https://zmijica.onrender.com/og.png">\n<meta name="theme-color" content="#0b121b">\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" href="og.png">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<style>:root{color-scheme:dark}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
  sed "s/__BUILD__/$ID/g" src/game.html
  printf '\n</body>\n</html>\n'
} > site/index.html
printf '%s\n' "$ID" > site/version.txt
echo "built site/index.html ($(wc -c < site/index.html) bytes)"
