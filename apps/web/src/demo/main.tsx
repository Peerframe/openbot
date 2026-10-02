import { DemoAdapter } from "./adapter";
import { installDemoTransport } from "./install";
import "../global-styles";
import "./demo.css";

const adapter = new DemoAdapter(location.origin);
installDemoTransport(adapter);
const [{ createRoot }, { Demo }] = await Promise.all([
  import("react-dom/client"),
  import("./Demo"),
]);
const root = document.getElementById("root");
if (!root) throw new Error("Demo root is missing.");
createRoot(root).render(<Demo adapter={adapter} />);
// Motion is opt-in; the parent may choose autoplay for an in-view iframe.
if (
  new URLSearchParams(location.search).get("autoplay") === "1" &&
  !matchMedia("(prefers-reduced-motion: reduce)").matches
)
  adapter.play();
