import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import "./workspace-shell.css";
import "./workspace-preferences.css";
import "./desktop-workspace.css";
import "./conversation-feedback.css";
import "./desktop-ui-refresh.css";
import "./settings-plugin-refresh.css";

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
