// bb-box's panels: a thread's boxes, each desktop box's viewer, each box's
// terminal, the Boxes page, the backends on the settings page, and the
// Monitor's machine status in the sidebar footer. They read everything through
// the RPC contract and refetch when the server says something changed.

import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { BOXES_ACTION } from "./src/app/common.tsx";
import { DESKTOP_ACTION, DESKTOP_PAGE, DesktopPanel, BoxesPage } from "./src/app/desktop.tsx";
import { BoxesPanel } from "./src/app/panel.tsx";
import { NewBoxInputs } from "./src/app/new-box-inputs.tsx";
import { SettingsSection } from "./src/app/settings.tsx";
import { TERMINAL_ACTION, TerminalPanel } from "./src/app/terminal.tsx";
import { registerMonitor } from "./src/app/monitor/status.tsx";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: BOXES_ACTION,
    title: "Box",
    component: BoxesPanel,
  });
  app.slots.threadPanelAction({
    id: DESKTOP_ACTION,
    title: "Desktop",
    component: DesktopPanel,
    layout: "flush",
  });
  app.slots.threadPanelAction({
    id: TERMINAL_ACTION,
    title: "Terminal",
    component: TerminalPanel,
    layout: "flush",
  });
  app.slots.navPanel({
    id: "boxes",
    title: "Boxes",
    // bb-box's cube, declared as "box" in package.json's experimental_icons:
    // BB resolves a plugin's icons by name, so the name must be one it declares.
    // The operator settled on the cube.
    icon: "bb-box/box",
    path: DESKTOP_PAGE,
    component: BoxesPage,
  });
  app.slots.settingsSection({
    id: "configuration",
    component: SettingsSection,
  });
  // "New box" in BB's new-thread screen (033): the kind and size of a thread's own box.
  app.slots.experimental_machineProviderInputs({
    machineProviderId: "bb-box-new",
    component: NewBoxInputs,
  });
  registerMonitor(app);
});
