import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./global-styles";
import { installAppFavicon } from "./app-favicon";
import { applyColorScheme } from "./color-scheme";
import { installOverlayScrollbars } from "./overlay-scrollbars";
import { readPreferences } from "./workspace-preferences";

installAppFavicon();
installOverlayScrollbars();

const runtime = window.openbotDesktop?.getRuntimeInfo?.();
if (runtime?.kind === "desktop") {
  document.documentElement.dataset.desktop = runtime.platform;
}

// Before the first render, so a dark choice never flashes the light palette.
applyColorScheme(readPreferences().colorScheme);

const root = document.getElementById("root");

if (root === null) {
  throw new Error("OpenBot root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
