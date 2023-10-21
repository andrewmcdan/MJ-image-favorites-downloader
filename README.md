# Midjourney Downloader
This is a node.js webapp that helps you download all your images from Midjourney. There are other ways to download Midjourney images, but I wanted a way to easily browse through all (or nearly all) of my images and select only the ones I want to download. Also, I wanted something reliable. 

## Usage

First step is to use [this chrome extension](https://github.com/andrewmcdan/midjourney-archive-chrome-extension) or [my fork](https://github.com/andrewmcdan/midjourney-archive-chrome-extension) (which has some added features) to get the json files with all the metadata.

Next download this repo and extract it. In the folder with app.js, create a folder where you want to download all your images to.

Then put all the zip files that the extension downloads into a folder called "zips". After running "npm install", "node app.js" will start the webserver and you can point your browser at "http://localhost:3000/images"

## Issues and PR's

This was a weekend project, so there's no polish to it. If you want to submit an issue or PR, feel free. 
