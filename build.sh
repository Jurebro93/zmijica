#!/bin/bash
# Wraps src/game.html (page body) into a full standalone document at site/index.html.
set -e
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="hr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="description" content="Vijuga: igra zmija za do 6 igrača. Skreći, preskači tragove, ostani zadnji živ.">\n<style>:root{color-scheme:dark;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
  cat src/game.html
  printf '\n</body>\n</html>\n'
} > site/index.html
echo "built site/index.html ($(wc -c < site/index.html) bytes)"
