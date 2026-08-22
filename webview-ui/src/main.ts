import "./tailwind.css";
import { createApp } from "vue";
import App from "./App.vue";
import { loadInitialState } from "./bootstrap";
import { setUiStrings } from "./composables/useUi";
import { installMockHost } from "./devMock";
import { vTip } from "./directives/tooltip";

// Strings must be available before any component setup runs — the blob is
// static per session, so a module-scope read before mount is enough.
setUiStrings(loadInitialState().ui);

// Browser dev preview: simulate the extension host (expandDir answers), load
// the codicon icon font (the real panel gets it via codiconCssUri) and apply
// the developer's active VS Code theme.
if (import.meta.env.MODE === "development") {
  await import("@vscode/codicons/dist/codicon.css");
  await import("./devTheme");
  installMockHost();
}

createApp(App).directive("tip", vTip).mount("#app");
