"use strict";

// Loads an extension script into a jsdom window with a mocked `browser` API.
// It runs as a classic script, as in the browser, so its top-level
// declarations can be reached with window.eval().

const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const EXTENSION_URL = "moz-extension://test-uuid/";

function storageArea(data) {
  return {
    async get(key) {
      if (key === null) {
        return { ...data };
      }
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of [].concat(keys)) {
        delete data[key];
      }
    },
    async clear() {
      for (const key of Object.keys(data)) {
        delete data[key];
      }
    },
  };
}

// sendMessage: handler for browser.runtime.sendMessage calls from the script.
function mockBrowser({ sendMessage = async () => undefined, local = {} } = {}) {
  const browser = {
    listeners: [],
    sentMessages: [],
    sentToTabs: [],
    local,
    session: {},
    runtime: {
      getURL: p => EXTENSION_URL + p.replace(/^\//, ""),
      sendMessage: async msg => {
        browser.sentMessages.push(msg);
        return sendMessage(msg);
      },
      onMessage: { addListener: listener => browser.listeners.push(listener) },
    },
    tabs: {
      sendMessage: async (...args) => {
        browser.sentToTabs.push(args);
      },
    },
  };
  browser.storage = {
    local: storageArea(browser.local),
    session: storageArea(browser.session),
  };
  return browser;
}

function loadScript(
  file,
  { html = "<!DOCTYPE html><html><body></body></html>", url, browser, globals }
) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const { window } = dom;
  window.browser = browser;
  if (!window.crypto?.randomUUID) {
    Object.defineProperty(window, "crypto", { value: webcrypto });
  }
  Object.assign(window, globals);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, file), "utf8"),
    dom.getInternalVMContext(),
    { filename: file }
  );
  return window;
}

// Lets pending promises and mutation observers run.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

module.exports = { EXTENSION_URL, ROOT, loadScript, mockBrowser, settle };
