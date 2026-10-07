# Images

Every box starts from an image. A standard image has the system and the tools most work needs. A project's image adds what one project needs, so its boxes start ready for it. BB Box rebuilds the standard Linux and macOS images each night, so they stay up to date.

## Project images

A project's image is the standard image with the project's own setup script run on it. The script runs as root. An optional check then runs as the box user, to make sure the setup worked. Both live in the project's repository, as `.bb/box-setup.sh` and `.bb/box-check.sh`.

A new box for one of the project's threads starts from the project's image, when the image covers that kind of box. You can choose Standard or another project's image instead in the New box form: see [making a box](making-a-box.md#image).

### Getting a project image

Ask an agent to make it. For a Linux box, the New box form offers this when your project has no image: select **Make a box image for this project**.

The agent:

1. Drafts the setup script from the project's own files, such as its devcontainer, Dockerfile and version files.
2. Tries the script in a new box, and fixes it until its checks pass.
3. Commits the scripts to the repository.
4. Sets the project's image.

Setting the image changes every new box of those kinds in the project, so the agent asks you first.

To see a project's images, run `bb box image list` or `bb box image show`. To remove one, run `bb box image remove`. See the [command-line reference](../reference/cli.md).

### How a box gets the project's image

At first, the setup script runs as each new box starts, before the box is yours. This adds the script's time to the start.

Once 2 boxes of the image have started on the same backend within 14 days, BB Box builds the image there in the background. The next box then starts from the build, with no wait for the script. An image can also be set to build straight away, or never.

When the script changes, BB Box builds the image again. A build that no box has started from for 30 days is deleted.

If the script fails as a box starts, the box shows 'Failed', and says the script failed and why.

To see which image a box has, run `bb box status` for the box. It says, for example, 'rust-tools, built 2 October', or 'its script ran as the box started, in 40 s'.

## Standard images stay up to date

Once it is set up, a BB automation runs `bb box images refresh` each night. To set it up, see [rebuilding images each night](../../README.md#rebuilding-images-each-night). It rebuilds the standard images that are due:

- a Linux image is due after a week
- a macOS image is due after a month

Windows images are not rebuilt yet. A Windows box starts from the image its setup guide made.

BB Box rebuilds one image at a time, the most needed first, and starts none after 4 hours. Each new build is tried in a box first. It replaces the old one only if the box passes its checks. A project's image is then built again on the new standard image.

To see each standard image's age and its last rebuild, run `bb box images list`. `bb box doctor` warns when a rebuild failed, or when no nightly run has finished for 8 days. See [health checks](../reference/checks.md).
