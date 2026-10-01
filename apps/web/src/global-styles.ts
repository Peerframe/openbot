/*
 * Global stylesheets in cascade order, shared by every entry (app, website demo, design preview).
 * Tokens first; the shared primitives directly after the legacy `styles.css` so they keep winning
 * over legacy rules of equal specificity. The legacy sheets are removed in plan step 23.
 */
import "./tokens.css";
import "./styles.css";
import "./primitives.css";
import "./workspace-shell.css";
import "./workspace-preferences.css";
import "./desktop-workspace.css";
import "./conversation-feedback.css";
import "./desktop-ui-refresh.css";
import "./settings-plugin-refresh.css";
