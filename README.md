# Midjourney Image Favorites Downloader / Server

This is a node.js application that helps you download all or some of your generated images and liked images from Midjourney. Although there are other ways to download Midjourney images, this provides a way to easily browse through all of your generated and liked images and select only the ones that you want to download. It is intended to run on something like Ubuntu Server in a headless environment, and it provides a web interface with a slideshow page.

### Slideshow Demo
<p align="center">
  <a href="https://youtu.be/9X8lLNcTQQE">
    <img src="https://github.com/andrewmcdan/readme-assets/blob/main/Midjourney_Image_Favorites_Downloader_Slideshow.gif?raw=true" width="480" alt="Midjourney Slideshow Demo" />
  </a>
</p>


## State of the Project
Most of the intended functionality is working. There are a few quality of life goals still to be attained, but this project is deployable. The following have not yet been implemented:
1. Automatic creation of database table with correct schema
2. Easy configuration of database credentials
3. Customization of the output folder
4. AI upscaling currently not working
5. "Tools" page currently out of date and not working

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

Finding the lines in the code to customize this shouldn't be too terribly difficult, but making this easier to configure is one of the quality of life goals, as mentioned above.

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

At this point, if you are running this on Windows desktop or Linux desktop, run "node app.js" then point your browser to the server: 

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

## The Home Page
When you point your browser at http://{ip-of-your-server}:3000 you'll be greeted with the somewhat simplistic interface to control the server. 

<p align="center">
  <img src="https://github.com/andrewmcdan/readme-assets/blob/main/mj-downloader.lan.png?raw=true" width="700" />
</p>

### "Status"
Provides basic information about the server.
### "Links"
Provides links to:
- Slide show page: This is the slide show that is demo'ed at the top of this ReadMe
- Images page: Here you can select the images that you want the server to download
- Tools: NOT WORKING
- Status: This returns a JSON string that shows a bunch of info about the server
### Config
- Set Run Enabled: Download, DB Update (database update), upscale update. Each of these sets the enabled state for their respective feature. 
### Triggers
- Download Run: Trigger the download to run. This normally runs at 1AM, but you can trigger it manually here.
- DB Update Run: Trigger the DB Update to run. This normally runs at midnight. Triggering it manually is useful to ensure that it has credentials stored for Midjourney. 
- Upscale Run: NOT WORKING
- Save Settings: NOT WORKING
- Reset Select Count: Each image in the database get a count of the number of times it is selected for a slideshow. Click this button to reset all the selection counts.
### Credentials
When needed, you should enter you Midjourney / Discord credentials here, then click login. Look for a message from the server indicating that credentials are needed. Multifactor Authentication is supported.
### Server Message Area
Messages form the server will show up beneath everything else, as well on any slideshow instances. Deleting a message on the home page will remove them from all the slideshow instances. If you are running a slideshow on something with a mouse, you can delete them there.

## SlideShows
My ultimate goal with this project was to get the images from Midjourney to my TV as a slideshow. To that end, I also created a [slideshow manager for the Raspberry Pi.](https://github.com/andrewmcdan/mj-launcher)

## Issues and PR's
This was a weekend project, so there's no polish to it. If you want to submit an issue or PR, feel free. 

## A note on Midjourney's ToS
Midjourney's terms of service state that you are not allowed to access their service(s) with automated tools. So, the use of this project almost certainly violates their ToS and may get you banned. USE AT YOUR OWN RISK!!