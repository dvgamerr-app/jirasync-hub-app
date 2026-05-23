import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initializeAccounts, migrateLegacyJiraSettings } from "@/lib/jira-db";

document.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

initializeAccounts().then(() => {
  migrateLegacyJiraSettings();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
