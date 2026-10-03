import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./global-styles";
import { installAppFavicon } from "./app-favicon";

installAppFavicon();

const runtime = window.openbotDesktop?.getRuntimeInfo?.();
if (runtime?.kind === "desktop") {
  document.documentElement.dataset.desktop = runtime.platform;
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("OpenBot root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
