#!/bin/sh
set -e
cd "$HOME"
. run/env.sh
script=$(base64 -w0 bb-box/docs/decisions/069-boxes-page/unit-3/in-box-sampler.sh)
for box in $(node -e 'for (const box of require(process.env.HOME + "/run/boxes.json")) if (box.role?.startsWith("quiet") || box.backend === "vm") console.log(box.name)'); do
  ./bbc box run "$box" --thread "$RUN_THREAD" "echo $script | base64 -d > ~/in-box-sampler.sh && nohup sh ~/in-box-sampler.sh > /dev/null 2>&1 & echo started on \$(hostname)"
done
