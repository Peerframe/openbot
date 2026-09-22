import { installDemoTransport } from "../demo/install";
import { ClientFixtureAdapter, clientScenarios } from "./adapter";
import "../styles.css";
import "../workspace-shell.css";
import "../workspace-preferences.css";
import "../desktop-workspace.css";
import "../conversation-round-one.css";
import "../desktop-ui-refresh.css";
import "../settings-plugin-refresh.css";
import "./fixtures.css";

const requested = new URLSearchParams(location.search).get("scenario") ?? "approval";
const scenario = clientScenarios.find((item) => item.id === requested);
if (!scenario) throw new Error("Unknown client fixture scenario");
const adapter = new ClientFixtureAdapter(location.origin, scenario.id);
installDemoTransport(adapter);
const [{ createRoot }, { ClientFixtures }] = await Promise.all([
  import("react-dom/client"),
  import("./ClientFixtures"),
]);
const root = document.getElementById("root");
if (!root) throw new Error("Client fixture root is missing");
createRoot(root).render(<ClientFixtures adapter={adapter} />);
window.addEventListener("pagehide", adapter.dispose, { once: true });
