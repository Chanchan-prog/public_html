// Ensure config runs first (defines API_BASE)
import "./config.js";

// ensure api service runs and exposes globals
import "./services/api.js";

import App from "./App.jsx";
import { registerPushWorker } from './services/pushNotifications.js';
import { installHtmlInputValidation } from './utils/htmlInputValidation.js';

installHtmlInputValidation(document);

const rootEl = document.getElementById('root');
ReactDOM.render(React.createElement(App, null), rootEl);
window.APP_RUNTIME_STARTED = true;

registerPushWorker().catch(error => {
  console.warn('[web_push] service worker registration unavailable', error);
});
