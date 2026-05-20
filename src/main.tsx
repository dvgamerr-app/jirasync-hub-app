import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { migrateLegacyJiraSettings } from "@/lib/jira-db";

migrateLegacyJiraSettings();

document.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
