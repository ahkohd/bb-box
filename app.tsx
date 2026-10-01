// bb-box's panels: a thread's boxes, each desktop box's viewer, the Desktops
// page, and the backends on the settings page. They read everything through
// the RPC contract and refetch when the server says something changed.

import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { DESKTOP_ACTION, DESKTOP_PAGE, DesktopPanel, DesktopsPage } from "./src/app/desktop.tsx";
import { BoxesPanel } from "./src/app/panel.tsx";
import { SettingsSection } from "./src/app/settings.tsx";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "boxes",
    title: "Box",
    component: BoxesPanel,
  });
  app.slots.threadPanelAction({
    id: DESKTOP_ACTION,
    title: "Desktop",
    component: DesktopPanel,
    layout: "flush",
  });
  app.slots.navPanel({
    id: "desktops",
    title: "Desktops",
    icon: "bb-box/monitor",
    path: DESKTOP_PAGE,
    component: DesktopsPage,
  });
  app.slots.settingsSection({
    id: "configuration",
    component: SettingsSection,
  });
});
