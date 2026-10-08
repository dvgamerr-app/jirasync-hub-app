import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { ensureDatabaseReady, initializeAccounts, migrateLegacyJiraSettings } from "@/lib/jira-db";

document.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

const root = document.getElementById("root") as HTMLElement;

function showDatabaseError(message: string) {
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText =
    "max-width:560px;margin:15vh auto;padding:24px;font:14px/1.6 system-ui,sans-serif";
  const title = document.createElement("h1");
  title.textContent = "The local database could not be opened";
  title.style.cssText = "font-size:18px;margin:0 0 8px";
  const body = document.createElement("p");
  body.textContent =
    "Your saved tasks and unpushed changes have NOT been deleted. This usually means the data was " +
    "written by a newer version of JiraSync Hub — update the app and try again.";
  const detail = document.createElement("pre");
  detail.textContent = message;
  detail.style.cssText = "white-space:pre-wrap;opacity:.7;font-size:12px";
  box.append(title, body, detail);
  root.replaceChildren(box);
}

async function start() {
  const databaseError = await ensureDatabaseReady();
  if (databaseError) {
    showDatabaseError(databaseError);
    return;
  }

  await initializeAccounts();
  migrateLegacyJiraSettings();
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
