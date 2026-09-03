(() => {
  "use strict";

  const COPY_MENU_ID = "copyN7Power";
  const PASTE_MENU_ID = "pasteN7Power";
  const COPIED_POWER_KEY = "copiedPower";
  const N7_URL_PATTERNS = ["https://n7.world/*", "https://*.n7.world/*"];
  const ROLL20_URL_PATTERNS = ["https://app.roll20.net/*"];

  chrome.runtime.onInstalled.addListener(() => {
    createContextMenus();
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(info, tab).catch((error) => {
      console.warn(`N7 PowerBridge: ${error.message}`);
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.action !== "n7.copyPower") {
      return false;
    }

    saveCopiedPower(message.powerData)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  });

  function createContextMenus() {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: COPY_MENU_ID,
        title: "Copy N7 Power",
        contexts: ["page", "selection"],
        documentUrlPatterns: N7_URL_PATTERNS
      });

      chrome.contextMenus.create({
        id: PASTE_MENU_ID,
        title: "Paste N7 Power into Roll20",
        contexts: ["page", "editable"],
        documentUrlPatterns: ROLL20_URL_PATTERNS
      });
    });
  }

  async function handleContextMenuClick(info, tab) {
    if (!tab || typeof tab.id !== "number") {
      return;
    }

    if (info.menuItemId === COPY_MENU_ID) {
      const response = await sendTabMessage(tab.id, { action: "n7.copyActivePower" }, info.frameId);
      if (!response || !response.ok) {
        throw new Error(response?.error || "N7 PowerBridge could not copy the selected power.");
      }
      return;
    }

    if (info.menuItemId === PASTE_MENU_ID) {
      const powerData = await getCopiedPower();

      if (!powerData) {
        await sendTabMessage(
          tab.id,
          {
            action: "roll20.showError",
            message: "No copied N7 power found. Copy a power from N7 World first."
          },
          info.frameId
        );
        return;
      }

      const response = await sendTabMessage(tab.id, { action: "roll20.pastePower", powerData }, info.frameId);
      if (!response || !response.ok) {
        throw new Error(response?.error || "N7 PowerBridge could not paste the copied power.");
      }
    }
  }

  async function saveCopiedPower(powerData) {
    validateCopiedPower(powerData);

    await storageSet({
      [COPIED_POWER_KEY]: {
        copiedAt: Date.now(),
        powerData
      }
    });
  }

  async function getCopiedPower() {
    const result = await storageGet(COPIED_POWER_KEY);
    return result[COPIED_POWER_KEY]?.powerData || null;
  }

  function validateCopiedPower(powerData) {
    if (!powerData || typeof powerData !== "object") {
      throw new Error("Parsed power data was empty.");
    }

    if (!powerData.name || typeof powerData.name !== "string") {
      throw new Error("Parsed power data is missing a name.");
    }

    if (!Number.isInteger(powerData.level) || powerData.level < 0 || powerData.level > 5) {
      throw new Error(
        `Unsupported power level "${String(powerData.level)}". Roll20 mapping supports cantrips and levels 1-5.`
      );
    }
  }

  function storageArea() {
    if (!chrome.storage || !chrome.storage.session) {
      throw new Error("chrome.storage.session is not available in this browser.");
    }

    return chrome.storage.session;
  }

  function storageGet(key) {
    return new Promise((resolve, reject) => {
      storageArea().get(key, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(result);
      });
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      storageArea().set(value, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve();
      });
    });
  }

  function sendTabMessage(tabId, message, frameId) {
    return new Promise((resolve, reject) => {
      const callback = (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      };

      if (typeof frameId === "number") {
        chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
      } else {
        chrome.tabs.sendMessage(tabId, message, callback);
      }
    });
  }
})();
