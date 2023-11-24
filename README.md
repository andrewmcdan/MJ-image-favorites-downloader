## This project is a work in progress. It's not ready for use yet.
I'm continually working on this project, so things may change. The goal is to get this to a point where it is stable enough for my personal use, but beyond that, I can't guarantee I'll work on it much more. As of the time of updating this ReadMe, this project is _really close_ to being usable.

# Midjourney Downloader
This is a node.js webapp that helps you download all or some of your images from Midjourney. There are other ways to download Midjourney images, but I wanted a way to easily browse through all (or nearly all) of my images and select only the ones I want to download. Also, I wanted something reliable. 

## Usage

Git clone this repo and then "npm i". You'll need to verify that the package.json isn't configured to use one of my local versions of any modules. 

If you are running this on Windows or Linux desktop, "node app.js" then point your browser to the server.
Linux headless, like Ubuntu Server requires that it be run with something like the line below so that puppeteer works:

xvfb-run -a --server-args="-screen 0 1280x800x24 -ac -nolisten tcp -dpi 96 +extension RANDR" node app

TODO: Add the rest of the usage

## Issues and PR's

This was a weekend project, so there's no polish to it. If you want to submit an issue or PR, feel free. 
