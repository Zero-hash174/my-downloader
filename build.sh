#!/usr/bin/env bash
# سيتم إيقاف التنفيذ إذا فشل أي أمر
set -o errexit

echo "Installing System Dependencies..."
# 1. تحديث وتثبيت ffmpeg و Python/pip
apt-get update
apt-get install -y ffmpeg python3 python3-pip

echo "Installing yt-dlp..."
# 2. تثبيت yt-dlp باستخدام pip
pip3 install yt-dlp

echo "Installing Node.js Dependencies..."
# 3. تثبيت حزم Node.js
npm install
