#!/bin/sh
box="$1"; target="$2"
cd "$HOME"
run() { ./bbc box run "$box" --machine "$1"; }
latest_undo() { ./bbc box snapshot list "$box" --machine --json | node -e 'let t="";process.stdin.on("data",(d)=>(t+=d)).on("end",()=>{const undos=JSON.parse(t).filter((r)=>r.undoOf).sort((a,b)=>b.takenAt-a.takenAt);console.log(undos[0].id)})'; }
run "echo nosync > ~/f1"
./bbc box snapshot restore "$box" "$target" --machine --replace | tail -1
undo=$(latest_undo)
./bbc box snapshot list "$box" --machine --json | node -e 'let t="";process.stdin.on("data",(d)=>(t+=d)).on("end",()=>{const u=JSON.parse(t).find((r)=>r.id===process.argv[1]);console.log("undo note:",u.note)})' "$undo"
./bbc box snapshot restore "$box" "$undo" --machine --replace | tail -1
echo "f1 after the undo: $(run 'cat ~/f1 2>&1')"
