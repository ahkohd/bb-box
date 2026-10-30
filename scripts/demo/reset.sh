#!/bin/sh
bb="${BB_CLI:-bb}"
for thread in $("$bb" thread list --json | python3 -c "import json, sys; data = json.load(sys.stdin); items = data if isinstance(data, list) else data.get('threads', data.get('items', [])); print(' '.join(item['id'] for item in items))"); do
  for box in $("$bb" box list --thread "$thread" | sed -n 's/^- \([a-z-]*\):.*/\1/p'); do
    "$bb" box release "$box" --thread "$thread" --force
  done
  "$bb" thread delete "$thread" --yes
done
"$bb" box list --all
"$bb" thread list
