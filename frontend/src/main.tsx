import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme, getThemeSetting } from "./lib/theme";

// Apply the persisted/system theme before the first paint so public routes
// (landing and login) match the authenticated workspace immediately.
applyTheme(getThemeSetting());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
