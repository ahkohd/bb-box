import { useEffect, useState } from "react";
import { definePluginApp, UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";

let mounts = 0;

function Probe() {
  const navigate = useBbNavigate();
  const [mount] = useState(() => ++mounts);
  const [hash, setHash] = useState(() => window.location.hash);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, []);
  return (
    <div data-probe="" data-mount={mount} data-hash={hash} data-count={count} className="space-y-2 text-sm">
      <p>
        mount {mount} · hash {hash || "(none)"} · count {count}
      </p>
      <button type="button" data-act="count" onClick={() => setCount((value) => value + 1)}>count</button>{" "}
      <button type="button" data-act="push-keep" onClick={() => { window.history.pushState(window.history.state, "", "#backend/docker"); setHash(window.location.hash); }}>push keeping state</button>{" "}
      <button type="button" data-act="push-null" onClick={() => { window.history.pushState(null, "", "#kind/linux"); setHash(window.location.hash); }}>push null state</button>{" "}
      <button type="button" data-act="assign" onClick={() => { window.location.hash = "option/monitor"; }}>assign hash</button>{" "}
      <button type="button" data-act="replace" onClick={() => { window.history.replaceState(window.history.state, "", "#backend/new"); setHash(window.location.hash); }}>replace</button>{" "}
      <UrlLink href="/settings/plugins/hashprobe#from-link/1" data-act="urllink-self">link to self with hash</UrlLink>{" "}
      <UrlLink href="/settings/plugins/bb-box#backend/docker" data-act="urllink-bbbox">link to bb-box with hash</UrlLink>{" "}
      <button type="button" data-act="openurl" onClick={() => { (window as unknown as { __openUrl?: boolean }).__openUrl = navigate.openUrl(`${window.location.origin}/settings/plugins/bb-box#kind/linux`); }}>openUrl with hash</button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "probe", component: Probe });
});
