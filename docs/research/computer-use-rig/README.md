# Computer-use rig

The local desktop used for the measurements in
[computer use](../computer-use.md). It is a test rig, not a bb-box template:
VNC has no password and Chrome runs without its sandbox.

It builds accessibility-cli at the measured commit, as released
(`accessibility-cli`) and with [the Chrome crash fix](acli-no-getall.patch)
(`acli-patched`), and installs Cua Driver 0.28.3 and 0.30.4 from their
release binaries, checked by SHA256.

```sh
docker build -t bbbox-cu-rig .
docker run -d --name cu-desk --shm-size=1g -p 127.0.0.1:15900:5900 bbbox-cu-rig
```

The desktop is on VNC at `127.0.0.1:15900`. Run the benchmarks as the
desktop user:

```sh
docker exec -u agent cu-desk bash -lc 'thunar & restart-chrome'
docker exec -u agent cu-desk bash -lc 'cua_bench2.py /opt/cua-0.30.4/cua-driver foreground'
docker exec -u agent cu-desk bash -lc 'cua_bench2.py /opt/cua-0.30.4/cua-driver background'
docker exec -u agent cu-desk bash -lc 'restart-chrome && acli-bench'
docker exec -u agent cu-desk bash -lc 'mousepad & xfce4-terminal & sleep 3; gtk_bench.py /opt/cua-0.30.4/cua-driver'
```

Run `restart-chrome` before each Chrome benchmark: the benchmarks change the
page. Each prints one JSON line per step with its time and result.

| File | What it does |
| --- | --- |
| `files/start-desktop` | starts Xtigervnc, XFCE and the test page's web server |
| `files/restart-chrome` | turns on AT-SPI for Chrome, restarts it on the test page and prints its PID |
| `files/web/index.html` | the test page: a form, 100 tasks and a canvas |
| `files/cua_bench.py` | first Cua pass: tree, screenshots, form, tokens, scrolling |
| `files/cua_bench2.py` | Cua in one delivery mode: token lifetime, stale tokens, pixel clicks |
| `files/gtk_bench.py` | Cua and accessibility-cli on Mousepad, Thunar and the terminal |
| `files/acli-bench` | accessibility-cli on the test page |
| `files/mcpc.py` | a minimal MCP client that runs a list of Cua tool calls |
