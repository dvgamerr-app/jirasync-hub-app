// Replaces @tauri-apps/plugin-http: route requests through the browser's fetch so
// Playwright's page.route() can serve a fake Jira.
export const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
