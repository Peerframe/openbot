import { subscribeWorkspace } from "./reader.mjs";

const status = document.querySelector("#status");
const form = document.querySelector("#login");
let stop;
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = new FormData(form).get("password");
  form.reset();
  try {
    const response = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error("Sign-in failed. Check the Server and password.");
    stop?.();
    stop = subscribeWorkspace({
      onState(state) {
        status.textContent = state;
      },
      onSnapshot(snapshot) {
        const counts = document.querySelector("#counts");
        counts.replaceChildren();
        for (const [name, count] of Object.entries(snapshot.counts)) {
          const term = document.createElement("dt");
          term.textContent = name;
          const value = document.createElement("dd");
          value.textContent = String(count);
          counts.append(term, value);
        }
        const runs = document.querySelector("#runs");
        runs.replaceChildren();
        for (const run of snapshot.runs) {
          const item = document.createElement("li");
          item.textContent = `${run.title} — ${run.status}`;
          runs.append(item);
        }
      },
    });
  } catch (error) {
    status.textContent = error.message;
  }
});
window.addEventListener("pagehide", () => stop?.());
