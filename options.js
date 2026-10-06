"use strict";

// Options page: an optional Bugzilla API key, and a button to clear the
// in-memory title and activity caches.

const input = document.getElementById("apiKey");
const statusText = document.getElementById("status");

function showStatus(text) {
  statusText.textContent = text;
  setTimeout(() => (statusText.textContent = ""), 2000);
}

browser.storage.local.get("apiKey").then(({ apiKey }) => {
  input.value = apiKey || "";
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = input.value.trim();
  if (apiKey) {
    await browser.storage.local.set({ apiKey });
  } else {
    await browser.storage.local.remove("apiKey");
  }
  await browser.runtime.sendMessage({ type: "clearCache" });
  showStatus("Saved.");
});

document.getElementById("clear").addEventListener("click", async () => {
  const count = await browser.runtime.sendMessage({ type: "clearCache" });
  showStatus(`Cleared ${count} cached title(s).`);
});
