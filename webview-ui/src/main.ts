import "./tailwind.css";
import { createApp } from "vue";
import App from "./App.vue";
import { loadInitialState } from "./bootstrap";
import { setUiStrings } from "./composables/useUi";

// Strings must be available before any component setup runs — the blob is
// static per session, so a module-scope read before mount is enough.
setUiStrings(loadInitialState().ui);

createApp(App).mount("#app");
