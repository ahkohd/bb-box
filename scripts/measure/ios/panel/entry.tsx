import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { DesktopViewer } from "../../../../src/app/desktop.tsx";

const root = document.getElementById("root")!;
createRoot(root).render(
  <>
    <DesktopViewer threadId="harness" boxId="harness-box" newTab={false} />
    <Toaster position="bottom-right" theme={document.documentElement.classList.contains("dark") ? "dark" : "light"} />
  </>,
);
