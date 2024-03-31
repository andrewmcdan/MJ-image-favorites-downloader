# Midjourney Image Favorites Downloader / Server

This is a node.js application that helps you download all or some of your generated images and liked images from Midjourney. Although there are other ways to download Midjourney images, this provides a way to easily browse through all of your generated and liked images and select only the ones that you want to download. It is intended to run on something like Ubuntu Server in a headless environment, and it provides a web interface with a slideshow page.

### Slideshow Demo
<p align="center">
  <a href="https://youtu.be/9X8lLNcTQQE">
    <img src="https://github.com/andrewmcdan/MJ-image-favorites-downloader/blob/main/Midjourney_Image_Favorites_Downloader_Slideshow.gif?raw=true" width="480" alt="Midjourney Slideshow Demo" />
  </a>
</p>


## State of the Project
Most of the intended functionality is working. There are a few quality of life goals still to be attained, but this project is deployable. The following have not yet been implemented:
1. Automatic creation of database table with correct schema
2. Easy configuration of database credentials
3. AI upscaling currently not working

## Prerequisites
1. Something that can run Node.js
2. A Postgres server

## Usage

As mentioned above, this application is meant to be run on something like Ubuntu Server, in a headless environment. It can be run on normal desktop environments, too, but you'll need to figure out the Postgres setup.

1. Clone this repo and cd into the folder
```
git clone https://github.com/andrewmcdan/MJ-image-favorites-downloader.git
cd Mj-image-favorites-downloader
```
2. Modify package.json

By default, this project is configured to use a local version of the AI-upscale-module dependency. You'll need to modify the package.json file to pull this dependency from github. 

Find the following line:
```
"ai-upscale-module": "file:../AI-Upscale-Module/",
```

And change it to: 

```
"ai-upscale-module": "git://github.com/andrewmcdan/AI-Upscale-Module.git",
```

3. Install node dependencies
```
npm i
```

4. Postgres setup

MJ Image Favorites Downloader expects to find a Postgres server with the following configuration:
> - user: 'mjuser',
> - host: 'postgresql.lan',
> - database: 'mjimages',
> - password: 'mjImagesPassword',
> - port: 9543,

You will have to create the database mjimages then you can use the following SQL to set up the schema:
```sql
CREATE TABLE public.images (
	id serial4 NOT NULL,
	"uuid" varchar(38) NOT NULL,
	grid_index int4 NOT NULL,
	parent_uuid uuid NOT NULL,
	enqueue_time timestamp NOT NULL,
	full_command varchar(6000) NOT NULL,
	width int4 NOT NULL,
	height int4 NOT NULL,
	storage_location varchar(1000) NOT NULL,
	downloaded bool NOT NULL,
	do_not_download bool NOT NULL,
	"index" int4 NOT NULL,
	times_selected int8 DEFAULT 0 NOT NULL,
	processed bool DEFAULT false NOT NULL,
	upscale_location varchar(2000) NULL,
	CONSTRAINT temp_table_pkey PRIMARY KEY (id, uuid)
);
CREATE INDEX temp_table_downloaded_do_not_download_processed_idx ON public.images USING btree (downloaded, do_not_download, processed);
CREATE INDEX temp_table_enqueue_time_idx ON public.images USING btree (enqueue_time);
CREATE INDEX temp_table_full_command_idx ON public.images USING btree (full_command);
CREATE INDEX temp_table_grid_index_parent_uuid_idx ON public.images USING btree (grid_index, parent_uuid);
CREATE INDEX temp_table_index_idx ON public.images USING btree (index);
CREATE INDEX temp_table_upscale_location_storage_location_idx ON public.images USING btree (upscale_location, storage_location);
```

At this point, if you are running this on Windows desktop or Linux desktop, "node app.js" then point your browser to the server: 

http://{ip-of-your-server}:3000

Port 3000 is the default but can be customized using an environment variable. More on that below. The downloaded images will be saved to "MJ-image-favorites-downloader/output/" and will be organized based on creation date.

## Linux headless
MJ Image Favorites Downloader uses the npm package Puppeteer to interact with the Midjourney servers. Ubuntu Server requires that it be run with something like the line below so that Puppeteer works:
```
xvfb-run -a --server-args="-screen 0 1280x800x24 -ac -nolisten tcp -dpi 96 +extension RANDR" node /full/path/to/app.js
```
In order for this to work, you'll have to install xvfb with:
```
sudo apt install xvfb
```

The easiest way to run this application persistently is with PM2. [See the PM2 docs for more on how to set that up.](https://pm2.keymetrics.io/docs/usage/quick-start/) Once PM2 is set up, you can use a bash script to start the MJ Image Favorites Downloader app with all the necessary environment variables and xvfb command.

```bash
#!/bin/bash
export mj_dl_server_port=3001
export mj_dl_server_log_level=5
export mj_dl_server_updateDB=true
export mj_dl_server_verifyDlOnStartup=true
export OMP_NUM_THREADS=1

cd /home/andrew/MJ-image-favorites-downloader/
xvfb-run -a --server-args="-screen 0 1920x1080x24 -ac -nolisten tcp -dpi 96 +extension RANDR" node /home/andrew/MJ-image-favorites-downloader/app.js
```

As you can see above, this will set the server port, the logging level (0-6), enabled DB update, and enabled download verification on startup. "OMP_NUM_THREADS" sets the max number of threads for AI upscaling.

## Issues and PR's

This was a weekend project, so there's no polish to it. If you want to submit an issue or PR, feel free. 
