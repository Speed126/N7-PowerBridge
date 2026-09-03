(() => {
  "use strict";

  const TOAST_ID = "n7-roll20-bridge-toast";
  const SUPPORTED_LEVELS = new Set([0, 1, 2, 3, 4, 5]);
  const ROLL20_ROW_SETTLE_DELAY_MS = 800;
  const ROLL20_FIELD_COMMIT_DELAY_MS = 400;
  const DEBUG = true;
  const LOG_PREFIX = "[N7 PowerBridge]";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !["roll20.pastePower", "roll20.showError"].includes(message.action)) {
      return false;
    }

    debug("Received Roll20 message", {
      action: message.action,
      power: summarizePower(message.powerData)
    });

    if (message.action === "roll20.showError") {
      showToast(message.message, "error");
      sendResponse({ ok: true });
      return false;
    }

    pastePower(message.powerData)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        warn("Paste failed", {
          message: error.message,
          stack: error.stack
        });
        showToast(error.message, "error");
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  });

  async function pastePower(powerData) {
    validatePowerForPaste(powerData);
    debug("Starting paste", summarizePower(powerData));

    const sheetDocument = await findCharacterSheetDocument();
    debug("Character sheet document found", {
      currentFrame: sheetDocument === document,
      title: sheetDocument.title || ""
    });

    const level = powerData.level;
    const targetSection = findPowerSection(sheetDocument, level);
    const existingItemCount = countRepeatingItems(targetSection.container);
    debug("Target Roll20 section selected", summarizeSectionCandidate(targetSection));

    targetSection.addButton.click();
    debug("Clicked Roll20 Add button", {
      existingRepeatingItems: existingItemCount,
      container: summarizeElement(targetSection.container)
    });

    let newPowerElement = await waitForNewRepeatingItem(targetSection.container, existingItemCount);
    debug("New Roll20 repeating item found", {
      newRepeatingItems: countRepeatingItems(targetSection.container),
      row: summarizeElement(newPowerElement)
    });

    newPowerElement = await waitForRepeatingItemReady(targetSection.container, existingItemCount, newPowerElement);
    await fillPowerFields(newPowerElement, powerData);
    await verifyPastedPower(newPowerElement, powerData);

    showToast(`Pasted ${powerData.name} into Roll20.`, "success");
    debug("Paste completed", summarizePower(powerData));
  }

  function validatePowerForPaste(powerData) {
    if (!powerData || typeof powerData !== "object") {
      throw new Error("No copied power data was provided. Copy a power from N7 World first.");
    }

    if (!powerData.name || typeof powerData.name !== "string") {
      throw new Error("The copied power is missing a name. Copy the power from N7 World again.");
    }

    if (!SUPPORTED_LEVELS.has(powerData.level)) {
      throw new Error(
        `Unsupported power level "${String(powerData.level)}". This extension maps only cantrips and levels 1-5.`
      );
    }
  }

  async function findCharacterSheetDocument() {
    return waitFor(
      () => {
        if (document.querySelector(".sheet-pc")) {
          return document;
        }

        const iframes = document.querySelectorAll('iframe[name^="iframe_"][title^="Character sheet for"], iframe');
        for (const iframe of iframes) {
          try {
            const iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDocument?.querySelector(".sheet-pc")) {
              return iframeDocument;
            }
          } catch {
            continue;
          }
        }

        return null;
      },
      {
        timeoutMs: 12000,
        description: "Roll20 character sheet is not ready. Open a character sheet and wait for it to finish loading."
      }
    );
  }

  function findPowerSection(sheetDocument, level) {
    const spellsSections = Array.from(sheetDocument.querySelectorAll(".sheet-spells"));
    const spellsSection = spellsSections.find(isSectionVisible) || spellsSections[0];

    if (!spellsSection) {
      throw new Error(
        "Could not find the Roll20 powers/spells section. Open the character sheet and switch to the powers or spells page."
      );
    }

    debug("Roll20 powers/spells section selected", {
      visible: isSectionVisible(spellsSection),
      totalSections: spellsSections.length,
      section: summarizeElement(spellsSection)
    });

    if (!isSectionVisible(spellsSection)) {
      throw new Error(
        "Found the Roll20 powers/spells section, but it is not visible. Switch the character sheet to the powers/spells page, then paste again."
      );
    }

    const sheetRoot = spellsSection.closest(".sheet-pc") || sheetDocument;
    const scopedAddButtons = Array.from(spellsSection.querySelectorAll(".repcontrol_add"));
    const rootAddButtons =
      scopedAddButtons.length > 0 ? scopedAddButtons : Array.from(sheetRoot.querySelectorAll(".repcontrol_add"));
    const visibleAddButtons = rootAddButtons.filter(isElementVisible);
    const addButtons = visibleAddButtons.length > 0 ? visibleAddButtons : rootAddButtons;
    const searchScope = scopedAddButtons.length > 0 ? "selected .sheet-spells" : "character sheet";
    const allCandidates = addButtons.map((addButton) => buildPowerSectionCandidate(addButton, spellsSection, sheetRoot));
    const candidates = allCandidates.filter((candidate) => candidate.section && sectionMatchesLevel(candidate, level));

    debug("Roll20 Add button candidates", {
      requestedLevel: level,
      searchScope,
      scopedAddButtons: scopedAddButtons.length,
      totalAddButtons: rootAddButtons.length,
      visibleAddButtons: visibleAddButtons.length,
      usableAddButtons: addButtons.length,
      candidates: allCandidates.map(summarizeSectionCandidate),
      matchedCandidates: candidates.map(summarizeSectionCandidate)
    });

    if (candidates.length === 0) {
      if (addButtons.length === 1) {
        return ensureCandidateHasContainer(
          buildPowerSectionCandidate(addButtons[0], spellsSection, sheetRoot),
          "Roll20 only exposed one Add button, but its repeating container (.repcontainer) is missing."
        );
      }

      throw new Error(
        `Could not find the Roll20 Add button for ${formatLevel(level)}. Found ${addButtons.length} usable Add button(s), but none matched that level.`
      );
    }

    return ensureCandidateHasContainer(
      candidates.find((item) => item.container) || candidates[0],
      `Found ${formatLevel(level)}, but its Roll20 repeating container (.repcontainer) is missing.`
    );
  }

  function ensureCandidateHasContainer(candidate, message) {
    if (!candidate.container) {
      throw new Error(message);
    }

    return candidate;
  }

  function buildPowerSectionCandidate(addButton, spellsSection, searchRoot = spellsSection) {
    const control = addButton.closest(".repcontrol");
    const section = control?.parentElement || addButton.parentElement;
    const groupName = findRepeatingGroupName(addButton, control, section);
    const container =
      findRepeatingContainer(section, groupName, true) ||
      findRepeatingContainer(spellsSection, groupName, false) ||
      (groupName && searchRoot !== spellsSection ? findRepeatingContainer(searchRoot, groupName, false) : null);
    const ancestors = [];
    let current = section;

    while (current && current !== spellsSection.parentElement && ancestors.length < 4) {
      ancestors.push(current);

      if (current === spellsSection) {
        break;
      }

      current = current.parentElement;
    }

    return {
      addButton,
      container,
      section,
      metadata: [
        ...ancestors.flatMap((element) => [
          element.className,
          element.id,
          element.getAttribute?.("name"),
          element.getAttribute?.("data-groupname")
        ]),
        groupName,
        container?.className,
        container?.getAttribute?.("data-groupname"),
        control?.className,
        control?.getAttribute?.("data-groupname"),
        addButton.getAttribute?.("data-groupname"),
        addButton.className
      ]
        .filter(Boolean)
        .join(" "),
      text: ancestors
        .filter((element) => element !== spellsSection)
        .map((element) => cleanText(element))
        .join(" ")
    };
  }

  function findRepeatingGroupName(...elements) {
    for (const element of elements) {
      if (!element) {
        continue;
      }

      const explicitName = element.getAttribute?.("data-groupname") || element.getAttribute?.("name");
      if (explicitName && /repeating[_-]spell/i.test(explicitName)) {
        return explicitName;
      }

      const className = String(element.className || "");
      const classMatch = className.match(/\brepeating[_-]spell[_-][\w-]+\b/i);
      if (classMatch) {
        return classMatch[0];
      }
    }

    return "";
  }

  function findRepeatingContainer(root, groupName, allowAnyContainer) {
    if (!root) {
      return null;
    }

    if (!groupName) {
      return root.querySelector(".repcontainer");
    }

    const escapedGroupName = cssEscape(groupName);
    return (
      root.querySelector(`.repcontainer[data-groupname="${escapedGroupName}"]`) ||
      root.querySelector(`.${escapedGroupName} .repcontainer`) ||
      (allowAnyContainer ? root.querySelector(".repcontainer") : null)
    );
  }

  function sectionMatchesLevel(candidate, level) {
    const metadata = cleanText(candidate.metadata).toLowerCase();
    const text = cleanText(candidate.text).toLowerCase();

    if (level === 0) {
      return (
        /\bcantrips?\b/.test(text) ||
        /\blevel\s*0\b/.test(text) ||
        /\brepeating[_-]spell[_-](?:cantrip|0)\b/.test(metadata) ||
        /\bsheet[_-]spell[_-](?:cantrip|0)\b/.test(metadata)
      );
    }

    return (
      new RegExp(`\\blevel\\s*${level}\\b`).test(text) ||
      new RegExp(`\\brepeating[_-]spell[_-]${level}\\b`).test(metadata) ||
      new RegExp(`\\bsheet[_-]spell[_-]level[_-]?${level}\\b`).test(metadata) ||
      new RegExp(`\\bsheet[_-]spell[_-]${level}\\b`).test(metadata)
    );
  }

  function countRepeatingItems(container) {
    return container.querySelectorAll(".repitem").length;
  }

  function waitForNewRepeatingItem(container, existingItemCount) {
    return waitFor(
      () => getNewestRepeatingItem(container, existingItemCount),
      {
        root: container,
        timeoutMs: 10000,
        description:
          "Roll20 did not create a new power row after Add was clicked. Wait for the sheet to finish loading, then try again."
      }
    );
  }

  async function waitForRepeatingItemReady(container, existingItemCount, initialPowerElement) {
    const readyPowerElement = await waitFor(
      () => {
        const powerElement = getNewestRepeatingItem(container, existingItemCount) || initialPowerElement;

        if (!powerElement?.isConnected) {
          return null;
        }

        const requiredFields = ["spelloutput", "spellname", "spelldescription"];
        const missingFields = requiredFields.filter((fieldName) => !findField(powerElement, fieldName));

        return missingFields.length === 0 ? powerElement : null;
      },
      {
        root: container,
        timeoutMs: 5000,
        description:
          "Roll20 created a new power row, but its editable fields did not finish loading. Wait for the sheet to finish loading, then try again."
      }
    );

    await delay(ROLL20_ROW_SETTLE_DELAY_MS);

    const settledPowerElement = getNewestRepeatingItem(container, existingItemCount) || readyPowerElement;
    debug("Roll20 repeating item ready for field fill", {
      row: summarizeElement(settledPowerElement),
      fields: summarizePowerRow(settledPowerElement)
    });

    return settledPowerElement;
  }

  function getNewestRepeatingItem(container, existingItemCount) {
    const items = Array.from(container.querySelectorAll(".repitem"));

    if (items.length <= existingItemCount) {
      return null;
    }

    return items[items.length - 1];
  }

  async function fillPowerFields(powerElement, powerData) {
    const spellOutput = getSpellOutput(powerData);
    await setFieldValue(powerElement, "spelloutput", spellOutput);
    await delay(250);

    const fieldMap = buildFieldMap(powerData, spellOutput);
    await stageAndCommitFields(powerElement, fieldMap);
    await delay(600);

    if (cleanText(readFieldValue(findField(powerElement, "spellname"))) !== cleanText(powerData.name)) {
      warn("Roll20 cleared the staged fields after the first commit; retrying once.", summarizePowerRow(powerElement));
      await stageAndCommitFields(powerElement, fieldMap);
    }

    debug("Roll20 field values after fill", summarizePowerRow(powerElement));
  }

  function buildFieldMap(powerData, spellOutput) {
    const fieldMap = [
      ["spellname", powerData.name],
      ["spellschool", powerData.school || "", { required: false }],
      ["spellcastingtime", powerData.castingTime || ""],
      ["spellrange", powerData.range || ""],
      ["spellduration", formatDuration(powerData)],
      ["spellconcentration", Boolean(powerData.concentration)],
      ["spell_ability", getSpellAbility(powerData.school), { required: false }],
      ["spelldescription", formatDescription(powerData)],
      ["spellathigherlevels", formatHigherLevels(powerData), { required: false }]
    ];

    if (spellOutput === "ATTACK") {
      if (isHealingPower(powerData.damageEffect)) {
        fieldMap.push(
          ["spellhealing", "1d6", { required: false }],
          ["spelldmgmod", true, { required: false }],
          ["spellhldie", "2", { required: false }],
          ["spellhldietype", "d6", { required: false }]
        );
      } else if (powerData.damageEffect) {
        fieldMap.push(
          ["spelldamage", "", { required: false }],
          ["spelldamagetype", powerData.damageEffect, { required: false }]
        );
      }

      const attackType = mapRoll20AttackType(powerData.attackType);
      if (attackType) {
        fieldMap.push(["spellattack", attackType, { required: false }]);
      } else if (powerData.attackType) {
        warn("Roll20 attack output does not support this N7 attack type; leaving Power Attack unchanged.", {
          attackType: powerData.attackType
        });
      }
    }

    const comboText = formatComboText(powerData);
    if (comboText) {
      fieldMap.push(["spelltarget", comboText, { required: false }]);
    }

    return fieldMap;
  }

  async function stageAndCommitFields(powerElement, fieldMap) {
    const fields = [];

    for (const [name, value, options] of fieldMap) {
      const field = await setFieldValue(powerElement, name, value, { ...options, commit: false });
      if (field) {
        fields.push(field);
      }
    }

    await commitFields(powerElement, fields);
  }

  async function commitFields(powerElement, fields) {
    const uniqueFields = Array.from(new Set(fields)).filter((field) => field?.isConnected);

    debug("Committing Roll20 fields", uniqueFields.map(summarizeField));

    for (const field of uniqueFields) {
      dispatchFieldEvents(field);
    }

    await delay(ROLL20_FIELD_COMMIT_DELAY_MS);
    debug("Roll20 field values after commit", summarizePowerRow(powerElement));
  }

  async function verifyPastedPower(powerElement, powerData) {
    await delay(600);

    const nameField = findField(powerElement, "spellname");
    const actualName = nameField ? cleanText(nameField.value) : "";
    const expectedName = cleanText(powerData.name);
    const visible = isSectionVisible(powerElement);

    debug("Post-paste verification", {
      expectedName,
      actualName,
      visible,
      row: summarizeElement(powerElement)
    });

    if (!visible) {
      throw new Error(
        "Roll20 created a new power row, but it is not visible. Make sure the character sheet is on the powers/spells page and try again."
      );
    }

    if (!actualName || actualName !== expectedName) {
      throw new Error(
        `Roll20 created a new power row, but the name field did not keep "${expectedName}". Check the field debug logs and try again.`
      );
    }
  }

  function getSpellAbility(school) {
    return String(school || "").toLowerCase().includes("tech") ? "@{intelligence_mod}+" : "@{wisdom_mod}+";
  }

  function getSpellOutput(powerData) {
    if (isHealingPower(powerData.damageEffect) || mapRoll20AttackType(powerData.attackType)) {
      return "ATTACK";
    }

    return "SPELLCARD";
  }

  function mapRoll20AttackType(attackType) {
    const normalized = cleanText(attackType).toLowerCase();

    if (normalized.includes("melee")) {
      return "Melee";
    }

    if (normalized.includes("ranged")) {
      return "Ranged";
    }

    return "";
  }

  function isHealingPower(damageEffect) {
    return String(damageEffect || "").toLowerCase() === "heal";
  }

  function formatComboText(powerData) {
    if (powerData.primes && powerData.detonates) {
      return "Primes & Detonates";
    }

    if (powerData.primes) {
      return "Primes";
    }

    if (powerData.detonates) {
      return "Detonates";
    }

    return "";
  }

  function formatDescription(powerData) {
    const parts = [];

    if (powerData.description) {
      parts.push(powerData.description);
    }

    if (Array.isArray(powerData.advancementOptions) && powerData.advancementOptions.length > 0) {
      const advancementText = powerData.advancementOptions
        .map((option) => `${option.title}: ${option.description}`)
        .join("\n");
      parts.push(`Advancement Options:\n${advancementText}`);
    }

    return parts.join("\n\n");
  }

  function formatHigherLevels(powerData) {
    return powerData.higherLevels ? stripHigherLevelsLabel(powerData.higherLevels) : "";
  }

  function formatDuration(powerData) {
    const duration = cleanText(powerData.duration);

    if (!powerData.concentration) {
      return duration;
    }

    return duration.replace(/^c\s*/i, "");
  }

  function stripHigherLevelsLabel(text) {
    return cleanText(text).replace(/^at higher levels?\.?:?\s*/i, "");
  }

  async function setFieldValue(powerElement, name, value, options = {}) {
    const field = findField(powerElement, name);
    const required = options.required !== false;
    const commit = options.commit !== false;

    if (!field) {
      if (!required) {
        debug("Optional Roll20 field missing; skipped", {
          name,
          value
        });
        return false;
      }

      throw new Error(`Expected Roll20 field "${name}" was not found in the new power row.`);
    }

    debug("Setting Roll20 field", {
      name,
      value,
      required,
      commit,
      field: summarizeField(field)
    });

    if (field.tagName === "SELECT") {
      const selectResult = setSelectValue(field, value);

      if (!selectResult.ok) {
        const message = `Roll20 field "${name}" has no select option matching "${String(value)}". Available options: ${selectResult.options.join(", ") || "(none)"}.`;

        if (!required) {
          warn("Optional Roll20 select value skipped", {
            name,
            value,
            availableOptions: selectResult.options
          });
          return false;
        }

        throw new Error(message);
      }
    } else if (field.type === "checkbox") {
      setNativeProperty(field, "checked", Boolean(value));
      if (value) {
        field.setAttribute("checked", "");
      } else {
        field.removeAttribute("checked");
      }
    } else {
      setTextFieldValue(field, value == null ? "" : String(value));
    }

    if (!commit) {
      debug("Roll20 field value staged", {
        name,
        expected: value,
        actual: readFieldValue(field),
        connected: field.isConnected,
        visible: isElementVisible(field)
      });
      return field;
    }

    dispatchFieldEvents(field);
    await delay(ROLL20_FIELD_COMMIT_DELAY_MS);
    debug("Roll20 field value after set", {
      name,
      expected: value,
      actual: readFieldValue(field),
      connected: field.isConnected,
      visible: isElementVisible(field)
    });
    return field;
  }

  function findField(powerElement, name) {
    const fields = Array.from(
      powerElement.querySelectorAll(
        `[name="attr_${name}"], [name$="attr_${name}"], [name$="_${name}"], [data-i18n-placeholder="${name}"]`
      )
    );

    return (
      fields.find((field) => isWritableField(field) && isElementVisible(field)) ||
      fields.find(isWritableField) ||
      fields[0] ||
      null
    );
  }

  function isWritableField(field) {
    return !field.disabled && field.type !== "hidden";
  }

  function setTextFieldValue(field, value) {
    setNativeProperty(field, "value", value);

    if (field.tagName === "TEXTAREA") {
      field.textContent = value;
    } else {
      field.setAttribute("value", value);
    }
  }

  function setNativeProperty(field, property, value) {
    const view = field.ownerDocument?.defaultView || window;
    const prototype =
      field.tagName === "TEXTAREA"
        ? view.HTMLTextAreaElement?.prototype
        : field.tagName === "SELECT"
          ? view.HTMLSelectElement?.prototype
          : field.type === "checkbox"
            ? view.HTMLInputElement?.prototype
            : view.HTMLInputElement?.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype || {}, property)?.set;

    if (setter) {
      setter.call(field, value);
    } else {
      field[property] = value;
    }
  }

  function dispatchFieldEvents(field) {
    const view = field.ownerDocument?.defaultView || window;

    field.dispatchEvent(new view.Event("input", { bubbles: true }));
    field.dispatchEvent(new view.Event("change", { bubbles: true }));
    field.dispatchEvent(new view.FocusEvent("focusout", { bubbles: true }));
    field.dispatchEvent(new view.FocusEvent("blur", { bubbles: false }));
  }

  function readFieldValue(field) {
    if (!field) {
      return "(missing)";
    }

    if (field.type === "checkbox") {
      return field.checked;
    }

    return field.value;
  }

  function setSelectValue(select, value) {
    const stringValue = value == null ? "" : String(value);
    const requested = normalizeSelectValue(stringValue);
    const options = Array.from(select.options).map((option) => ({
      value: cleanText(option.value),
      text: cleanText(option.textContent)
    }));
    const matchingOption = Array.from(select.options).find((option) => {
      const optionValue = normalizeSelectValue(option.value);
      const optionText = normalizeSelectValue(option.textContent);

      return (
        optionValue === requested ||
        optionText === requested ||
        (requested.length > 2 && optionText.includes(requested)) ||
        (requested.length > 2 && optionValue.includes(requested))
      );
    });

    if (!matchingOption) {
      return {
        ok: false,
        options: options.map((option) => `${option.value || "(blank)"}:${option.text || "(blank)"}`)
      };
    }

    setNativeProperty(select, "value", matchingOption.value);
    matchingOption.selected = true;
    debug("Matched Roll20 select option", {
      name: select.name,
      requested: stringValue,
      selectedValue: matchingOption.value,
      selectedText: cleanText(matchingOption.textContent)
    });

    return {
      ok: true,
      options
    };
  }

  function waitFor(predicate, options) {
    const root = options.root || document.documentElement || document.body;
    const timeoutMs = options.timeoutMs || 10000;
    const description = options.description || "Timed out waiting for Roll20.";

    return new Promise((resolve, reject) => {
      let settled = false;
      let observer;
      let intervalId;
      let timeoutId;

      const cleanup = () => {
        if (observer) {
          observer.disconnect();
        }

        window.clearInterval(intervalId);
        window.clearTimeout(timeoutId);
      };

      const finish = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        callback(value);
      };

      const check = () => {
        try {
          const value = predicate();
          if (value) {
            finish(resolve, value);
          }
        } catch (error) {
          finish(reject, error);
        }
      };

      observer = new MutationObserver(check);
      observer.observe(root, {
        childList: true,
        subtree: true
      });

      intervalId = window.setInterval(check, 250);
      timeoutId = window.setTimeout(() => finish(reject, new Error(description)), timeoutMs);
      check();
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
    toast.textContent = message || "N7 PowerBridge failed.";
    document.documentElement.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
    }, type === "error" ? 8000 : 4200);
  }

  function ensureToastStyles() {
    if (document.getElementById("n7-roll20-bridge-styles")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "n7-roll20-bridge-styles";
    style.textContent = `
      .n7-roll20-bridge-toast {
        border-radius: 6px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.24);
        color: #ffffff;
        font: 14px/1.35 Arial, sans-serif;
        max-width: min(380px, calc(100vw - 32px));
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

  function formatLevel(level) {
    return level === 0 ? "cantrips" : `level ${level}`;
  }

  function cleanText(value) {
    if (!value) {
      return "";
    }

    const text = typeof value === "string" ? value : value.textContent;

    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeSelectValue(value) {
    return cleanText(value).toLowerCase();
  }

  function summarizePower(powerData) {
    if (!powerData || typeof powerData !== "object") {
      return null;
    }

    return {
      name: powerData.name,
      level: powerData.level,
      school: powerData.school,
      castingTime: powerData.castingTime,
      range: powerData.range,
      duration: powerData.duration,
      concentration: Boolean(powerData.concentration),
      primes: Boolean(powerData.primes),
      detonates: Boolean(powerData.detonates),
      attackType: powerData.attackType,
      damageEffect: powerData.damageEffect,
      higherLevels: Boolean(powerData.higherLevels)
    };
  }

  function summarizePowerRow(powerElement) {
    const fieldNames = [
      "spellname",
      "spellschool",
      "spellcastingtime",
      "spellrange",
      "spellduration",
      "spellconcentration",
      "spelllevel",
      "spell_ability",
      "spelloutput",
      "spellattack",
      "spelldamage",
      "spelldamagetype",
      "spelltarget",
      "spelldescription",
      "spellathigherlevels"
    ];

    return Object.fromEntries(
      fieldNames.map((name) => {
        const field = findField(powerElement, name);

        return [name, readFieldValue(field)];
      })
    );
  }

  function summarizeSectionCandidate(candidate) {
    return {
      hasSection: Boolean(candidate.section),
      hasContainer: Boolean(candidate.container),
      metadata: candidate.metadata,
      text: candidate.text.slice(0, 240),
      addButton: summarizeElement(candidate.addButton),
      container: summarizeElement(candidate.container)
    };
  }

  function summarizeField(field) {
    const summary = summarizeElement(field);
    summary.name = field.name || "";
    summary.type = field.type || "";
    summary.tagName = field.tagName;
    summary.value = readFieldValue(field);
    summary.visible = isElementVisible(field);
    summary.connected = field.isConnected;

    if (field.tagName === "SELECT") {
      summary.options = Array.from(field.options).map((option) => ({
        value: cleanText(option.value),
        text: cleanText(option.textContent)
      }));
    }

    return summary;
  }

  function summarizeElement(element) {
    if (!element) {
      return null;
    }

    return {
      tagName: element.tagName,
      id: element.id || "",
      className: String(element.className || ""),
      name: element.getAttribute?.("name") || "",
      dataGroupName: element.getAttribute?.("data-groupname") || "",
      dataRepRowId: element.getAttribute?.("data-reprowid") || "",
      dataRepIndex: element.getAttribute?.("data-repindex") || ""
    };
  }

  function debug(message, details) {
    if (!DEBUG) {
      return;
    }

    if (details === undefined) {
      console.log(LOG_PREFIX, message);
    } else {
      console.log(LOG_PREFIX, message, details);
    }
  }

  function warn(message, details) {
    if (details === undefined) {
      console.warn(LOG_PREFIX, message);
    } else {
      console.warn(LOG_PREFIX, message, details);
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/["\\]/g, "\\$&");
  }

  function isSectionVisible(element) {
    if (!element) {
      return false;
    }

    if (isElementVisible(element)) {
      return true;
    }

    return Array.from(element.querySelectorAll("input, textarea, select, button, .repitem")).some(isElementVisible);
  }

  function isElementVisible(element) {
    if (!element) {
      return false;
    }

    const view = element.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(element);

    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return Array.from(element.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }
})();
