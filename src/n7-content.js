(() => {
  "use strict";

  const parser = globalThis.N7Roll20BridgePowerParser;
  const COPY_BUTTON_CLASS = "n7-roll20-bridge-copy-button";
  const TOAST_ID = "n7-roll20-bridge-toast";

  if (!parser) {
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.action !== "n7.copyActivePower") {
      return false;
    }

    copyActivePower()
      .then((powerData) => sendResponse({ ok: true, powerData }))
      .catch((error) => {
        showToast(error.message, "error");
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  });

  function boot() {
    ensureToastStyles();
    addCopyButtons();

    const observer = new MutationObserver(() => {
      addCopyButtons();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function addCopyButtons() {
    const headers = document.querySelectorAll(".v-expansion-panel-header");

    headers.forEach((header) => {
      if (header.querySelector(`.${COPY_BUTTON_CLASS}`)) {
        return;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = COPY_BUTTON_CLASS;
      button.textContent = "Copy Power";
      button.addEventListener("click", onCopyButtonClick);
      header.appendChild(button);
    });
  }

  async function onCopyButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const powerPanel = event.currentTarget.closest(".v-expansion-panel");

    try {
      const powerData = await copyPowerPanel(powerPanel);
      showToast(`Copied ${powerData.name}. Switch to Roll20 and use Paste Power.`, "success");
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function copyActivePower() {
    const activePanel = findActivePowerPanel();
    const powerData = await copyPowerPanel(activePanel);

    showToast(`Copied ${powerData.name}. Switch to Roll20 and use Paste Power.`, "success");
    return powerData;
  }

  async function copyPowerPanel(powerPanel) {
    if (!powerPanel) {
      throw new Error("Open an N7 power panel, then choose Copy Power again.");
    }

    const powerData = parser.parsePowerElement(powerPanel);
    const response = await sendRuntimeMessage({
      action: "n7.copyPower",
      powerData
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || "The extension could not save the copied power.");
    }

    return powerData;
  }

  function findActivePowerPanel() {
    const activePanel = document.querySelector(".v-expansion-panel--active");

    if (activePanel) {
      return activePanel;
    }

    const expandedHeader = document.querySelector('.v-expansion-panel-header[aria-expanded="true"]');
    if (expandedHeader) {
      return expandedHeader.closest(".v-expansion-panel");
    }

    const panels = document.querySelectorAll(".v-expansion-panel");
    return panels.length === 1 ? panels[0] : null;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      });
    });
  }

  function showToast(message, type) {
    ensureToastStyles();

    const existingToast = document.getElementById(TOAST_ID);
    if (existingToast) {
      existingToast.remove();
    }

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = `n7-roll20-bridge-toast n7-roll20-bridge-toast-${type}`;
    toast.textContent = message;
    document.documentElement.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
    }, type === "error" ? 7000 : 4200);
  }

  function ensureToastStyles() {
    if (document.getElementById("n7-roll20-bridge-styles")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "n7-roll20-bridge-styles";
    style.textContent = `
      .${COPY_BUTTON_CLASS} {
        appearance: none;
        border: 1px solid #0f5134;
        border-radius: 4px;
        background: #176b45;
        color: #ffffff;
        cursor: pointer;
        font: 600 12px/1.2 Arial, sans-serif;
        margin-left: 12px;
        padding: 6px 10px;
        white-space: nowrap;
      }

      .${COPY_BUTTON_CLASS}:hover {
        background: #0f5134;
      }

      .${COPY_BUTTON_CLASS}:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }

      .n7-roll20-bridge-toast {
        border-radius: 6px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
        color: #ffffff;
        font: 14px/1.35 Arial, sans-serif;
        max-width: min(360px, calc(100vw - 32px));
        padding: 10px 12px;
        position: fixed;
        right: 16px;
        top: 16px;
        z-index: 2147483647;
      }

      .n7-roll20-bridge-toast-success {
        background: #155f46;
      }

      .n7-roll20-bridge-toast-error {
        background: #8f1d1d;
      }
    `;
    document.documentElement.appendChild(style);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
