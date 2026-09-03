(function definePowerParser(root, factory) {
  const parser = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = parser;
  }

  root.N7Roll20BridgePowerParser = parser;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  "use strict";

  const SUPPORTED_LEVELS = new Set([0, 1, 2, 3, 4, 5]);
  const MISSING_VALUE_PATTERN = /^(?:[-\u2013\u2014]|n\/a|none)$/i;
  const LEVEL_WORDS = new Map([
    ["zero", 0],
    ["first", 1],
    ["one", 1],
    ["second", 2],
    ["two", 2],
    ["third", 3],
    ["three", 3],
    ["fourth", 4],
    ["four", 4],
    ["fifth", 5],
    ["five", 5]
  ]);

  class PowerParseError extends Error {
    constructor(message) {
      super(message);
      this.name = "PowerParseError";
    }
  }

  function parsePowerElement(powerElement) {
    if (!isQueryable(powerElement)) {
      throw new PowerParseError("No N7 power panel was provided to parse.");
    }

    const name = readName(powerElement);
    if (!name) {
      throw new PowerParseError("Could not read the power name from the N7 power panel.");
    }

    const stats = readStatCards(powerElement);
    const level = normalizePowerLevel(readPowerLevel(stats, powerElement));
    const durationDetails = readDuration(stats, powerElement);
    const comboDetails = readCombo(readStat(stats, "combo", 4));
    const descriptionDetails = readDescriptionDetails(powerElement);

    const powerData = {
      name,
      level,
      school: normalizeSchool(readStat(stats, "school")) || "Tech",
      castingTime: cleanOptionalValue(readStat(stats, "castingTime", 1)),
      duration: durationDetails.duration,
      concentration: durationDetails.concentration,
      range: cleanOptionalValue(readStat(stats, "range", 3)),
      primes: comboDetails.primes,
      detonates: comboDetails.detonates,
      attackType: cleanOptionalValue(readStat(stats, "attackType", 5)),
      damageEffect: cleanOptionalValue(readStat(stats, "damageEffect", 6)),
      description: descriptionDetails.description,
      higherLevels: descriptionDetails.higherLevels,
      advancementOptions: readAdvancementOptions(powerElement)
    };

    validatePowerData(powerData);
    return powerData;
  }

  function validatePowerData(powerData) {
    if (!powerData || typeof powerData !== "object") {
      throw new PowerParseError("Parsed power data was empty.");
    }

    if (!powerData.name || typeof powerData.name !== "string") {
      throw new PowerParseError("Parsed power data is missing a power name.");
    }

    if (!SUPPORTED_LEVELS.has(powerData.level)) {
      throw new PowerParseError(
        `Unsupported power level "${String(powerData.level)}". Roll20 mapping supports cantrips and levels 1-5.`
      );
    }

    return true;
  }

  function normalizePowerLevel(rawLevel) {
    const levelText = cleanText(rawLevel).toLowerCase();

    if (!levelText) {
      throw new PowerParseError("Could not read the power level from the N7 power panel.");
    }

    if (levelText.includes("cantrip")) {
      return 0;
    }

    const numericMatch =
      levelText.match(/\b(?:power\s*)?level\s*(\d+)\b/) ||
      levelText.match(/\b(\d+)(?:st|nd|rd|th)?(?:\s*[- ]?\s*level)?\b/);
    const wordLevel = readWordLevel(levelText);
    const numericLevel = numericMatch ? Number.parseInt(numericMatch[1], 10) : wordLevel;

    if (numericLevel == null) {
      throw new PowerParseError(`Unsupported power level "${cleanText(rawLevel)}".`);
    }

    if (!SUPPORTED_LEVELS.has(numericLevel)) {
      throw new PowerParseError(
        `Unsupported power level "${cleanText(rawLevel)}". Roll20 mapping supports cantrips and levels 1-5.`
      );
    }

    return numericLevel;
  }

  function readWordLevel(levelText) {
    for (const [word, level] of LEVEL_WORDS) {
      const wordPattern = escapeRegExp(word);

      if (
        new RegExp(`\\b(?:power\\s*)?level\\s*${wordPattern}\\b`).test(levelText) ||
        new RegExp(`\\b${wordPattern}(?:\\s*[- ]?\\s*level)?\\b`).test(levelText)
      ) {
        return level;
      }
    }

    return null;
  }

  function readName(powerElement) {
    const namedChild = cleanText(
      textFromFirst(powerElement, [
        "[data-n7-power-name]",
        ".text-h6",
        ".v-expansion-panel-header .text-h6",
        ".text-h5",
        ".v-expansion-panel-header .text-h5",
        ".v-card-title",
        ".v-toolbar-title",
        "h1",
        "h2",
        "h3"
      ])
    );

    if (namedChild) {
      return stripInjectedControlText(namedChild);
    }

    const header = powerElement.querySelector(".v-expansion-panel-header");
    return stripInjectedControlText(readTextWithoutBridgeControls(header));
  }

  function readStatCards(powerElement) {
    const cards = Array.from(
      powerElement.querySelectorAll("[data-n7-field], .n7-power-stat, .power-stat, .col-md-3.col-6")
    );

    return cards.map((element, index) => {
      const dataField = cleanText(element.getAttribute("data-n7-field"));
      const labelElement = element.querySelector(
        "[data-n7-label], .text-caption, .text-overline, .text-subtitle-1, .text-subtitle-2"
      );
      const valueElement = element.querySelector("[data-n7-value], .text-body-2, .text-body-1");
      const label = dataField || cleanText(labelElement);
      const value = valueElement ? cleanText(valueElement) : stripLabelFromValue(cleanText(element), label);

      return {
        element,
        index,
        label,
        value
      };
    });
  }

  function readStat(stats, fieldName, fallbackIndex) {
    const aliases = {
      level: [/^level$/, /power level/],
      school: [/^school$/, /^type$/, /power type/],
      castingTime: [/casting time/, /^time$/],
      duration: [/duration/],
      range: [/range/],
      combo: [/prime/, /detonate/, /combo/],
      attackType: [/attack type/, /^attack$/],
      damageEffect: [/damage/, /effect/]
    };

    const labeledStat = stats.find((stat) =>
      aliases[fieldName].some((pattern) => pattern.test(stat.label.toLowerCase()))
    );

    if (labeledStat && cleanOptionalValue(labeledStat.value)) {
      return labeledStat.value;
    }

    const hasAnyLabels = stats.some((stat) => stat.label);
    if (!hasAnyLabels && typeof fallbackIndex === "number" && stats[fallbackIndex]) {
      return stats[fallbackIndex].value;
    }

    return "";
  }

  function readPowerLevel(stats, powerElement) {
    const explicitLevel = readStat(stats, "level", 0);
    if (cleanOptionalValue(explicitLevel)) {
      return explicitLevel;
    }

    const statLevel = stats.find((stat) => {
      const combined = cleanText(`${stat.label} ${stat.value}`);

      return (
        combined &&
        (/\blevel\b/i.test(combined) || /\bcantrip\b/i.test(combined) || stat.index === 0) &&
        canReadPowerLevel(combined)
      );
    });

    if (statLevel) {
      return cleanText(`${statLevel.label} ${statLevel.value}`);
    }

    const headerText = readTextWithoutBridgeControls(powerElement.querySelector(".v-expansion-panel-header"));
    const headerLevel = findLevelPhrase(headerText);

    return headerLevel || explicitLevel;
  }

  function canReadPowerLevel(value) {
    try {
      normalizePowerLevel(value);
      return true;
    } catch {
      return false;
    }
  }

  function findLevelPhrase(text) {
    const normalized = cleanText(text);

    return (
      normalized.match(/\bcantrip\b/i)?.[0] ||
      normalized.match(/\b(?:power\s*)?level\s*\d+\b/i)?.[0] ||
      normalized.match(/\b\d+(?:st|nd|rd|th)?(?:\s*[- ]?\s*level)\b/i)?.[0] ||
      normalized.match(/\b(?:first|second|third|fourth|fifth|one|two|three|four|five)(?:\s*[- ]?\s*level)\b/i)?.[0] ||
      ""
    );
  }

  function readDuration(stats, powerElement) {
    const durationStat = stats.find((stat) =>
      [/duration/].some((pattern) => pattern.test(stat.label.toLowerCase()))
    );
    const fallbackStat = stats[2];
    const stat = durationStat || fallbackStat;
    const rawDuration = stat ? stat.value : "";
    const durationElement = stat ? stat.element : powerElement;
    const concentration =
      hasConcentrationMarker(durationElement) || /\bconcentration\b/i.test(cleanText(rawDuration));
    const duration = cleanOptionalValue(cleanText(rawDuration).replace(/^concentration\s*[:,.-]?\s*/i, ""));

    return {
      duration,
      concentration
    };
  }

  function hasConcentrationMarker(element) {
    if (!isQueryable(element)) {
      return false;
    }

    return Boolean(
      element.querySelector(
        '.v-avatar, [aria-label*="concentration" i], [title*="concentration" i], [data-concentration="true"]'
      )
    );
  }

  function readCombo(comboText) {
    const normalized = cleanText(comboText).toLowerCase();

    return {
      primes: /\bprimes?\b/.test(normalized),
      detonates: /\bdetonates?\b/.test(normalized)
    };
  }

  function readDescriptionDetails(powerElement) {
    const descriptionElement = powerElement.querySelector("[data-n7-description], .me-html.text-body-2, .me-html");
    const descriptionText = descriptionElement ? blockText(descriptionElement) : "";
    const splitDescription = splitHigherLevels(descriptionText);
    const higherLevels =
      splitDescription.higherLevels || readStandaloneHigherLevels(powerElement, descriptionElement);

    return {
      description: cleanOptionalValue(splitDescription.description),
      higherLevels: cleanOptionalValue(higherLevels)
    };
  }

  function readStandaloneHigherLevels(powerElement, descriptionElement) {
    const candidates = Array.from(powerElement.querySelectorAll("[data-n7-higher-levels], .higher-levels, p, div"));
    const element = candidates.find((candidate) => {
      if (candidate === descriptionElement || candidate.closest("[data-n7-description], .me-html")) {
        return false;
      }

      return /^at higher levels?/i.test(cleanText(candidate));
    });

    return element ? stripHigherLevelsLabel(blockText(element)) : "";
  }

  function splitHigherLevels(text) {
    const normalized = cleanText(text);
    const match = normalized.match(/\bat higher levels?\.?:?\s*/i);

    if (!match || typeof match.index !== "number") {
      return {
        description: normalized,
        higherLevels: ""
      };
    }

    return {
      description: cleanText(normalized.slice(0, match.index)),
      higherLevels: stripHigherLevelsLabel(normalized.slice(match.index))
    };
  }

  function stripHigherLevelsLabel(text) {
    return cleanProseText(text).replace(/^at higher levels?\.?:?\s*/i, "");
  }

  function readAdvancementOptions(powerElement) {
    const scopedContainer = powerElement.querySelector("[data-n7-advancements], .n7-advancements, .advancement-options");
    const scope = scopedContainer || powerElement;
    const candidates = Array.from(
      scope.querySelectorAll("[data-n7-advancement], .advancement-option, .v-expansion-panel-content__wrap > div")
    );
    const seen = new Set();

    return candidates
      .map((candidate) => {
        const title = cleanTitle(
          textFromFirst(candidate, ["[data-n7-advancement-title]", "strong", ".text-subtitle-1", ".text-subtitle-2"])
        );
        const description = cleanOptionalValue(
          textFromFirst(candidate, ["[data-n7-advancement-description]", "p", ".text-body-2"])
        );

        return {
          title,
          description
        };
      })
      .filter((option) => {
        if (!option.title || !option.description || /^at higher levels?/i.test(option.title)) {
          return false;
        }

        const key = `${option.title}\n${option.description}`;
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });
  }

  function normalizeSchool(rawSchool) {
    const school = cleanOptionalValue(rawSchool);

    if (!school) {
      return "";
    }

    const lower = school.toLowerCase();
    if (lower.includes("tech")) {
      return "Tech";
    }

    if (lower.includes("biotic")) {
      return "Biotic";
    }

    if (lower.includes("combat")) {
      return "Combat";
    }

    return school;
  }

  function textFromFirst(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = cleanText(element);

      if (value) {
        return value;
      }
    }

    return "";
  }

  function readTextWithoutBridgeControls(element) {
    if (!element) {
      return "";
    }

    const clone = element.cloneNode(true);
    clone
      .querySelectorAll(".n7-roll20-bridge-copy-button, #n7-roll20-bridge-toast")
      .forEach((child) => child.remove());

    return cleanText(clone);
  }

  function stripInjectedControlText(value) {
    return cleanText(value).replace(/\bCopy Power\b$/i, "").trim();
  }

  function blockText(element) {
    const blocks = Array.from(element.querySelectorAll("p, li"))
      .filter((block) => !isProbablyHidden(block))
      .map((block) => cleanProseText(block))
      .filter(Boolean);
    const paragraphs = blocks.length > 0 ? blocks : textParagraphs(element);

    return dedupeRepeatedParagraphs(paragraphs).join("\n");
  }

  function stripLabelFromValue(text, label) {
    if (!label) {
      return text;
    }

    return cleanText(text).replace(new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*`, "i"), "");
  }

  function cleanTitle(value) {
    return cleanText(value).replace(/:$/, "");
  }

  function cleanOptionalValue(value) {
    const text = cleanText(value);

    if (!text || MISSING_VALUE_PATTERN.test(text)) {
      return "";
    }

    return text;
  }

  function textParagraphs(value) {
    const text = rawText(value)
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n")
      .trim();

    return text
      .split(/\n{2,}/)
      .map((paragraph) => cleanProseText(paragraph))
      .filter(Boolean);
  }

  function cleanProseText(value) {
    return rawText(value)
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function dedupeRepeatedParagraphs(paragraphs) {
    const deduped = paragraphs.map(removeRepeatedText).filter(Boolean);

    for (let size = 1; size <= deduped.length / 2; size += 1) {
      if (deduped.length % size !== 0) {
        continue;
      }

      const repeats = deduped.every((paragraph, index) => paragraph === deduped[index % size]);
      if (repeats) {
        return deduped.slice(0, size);
      }
    }

    return deduped.filter((paragraph, index) => paragraph !== deduped[index - 1]);
  }

  function removeRepeatedText(text) {
    const prose = cleanProseText(text);
    const halfLength = prose.length / 2;

    if (Number.isInteger(halfLength) && prose.slice(0, halfLength) === prose.slice(halfLength)) {
      return prose.slice(0, halfLength).trim();
    }

    return prose;
  }

  function cleanText(value) {
    return rawText(value)
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function rawText(value) {
    if (!value) {
      return "";
    }

    return String(typeof value === "string" ? value : value.textContent || "");
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isQueryable(value) {
    return Boolean(value && typeof value.querySelector === "function");
  }

  function isProbablyHidden(element) {
    const className = String(element.className || "");
    const style = String(element.getAttribute?.("style") || "");

    return (
      element.hidden ||
      element.getAttribute?.("aria-hidden") === "true" ||
      /\b(?:d-none|hidden|sr-only|visually-hidden)\b/i.test(className) ||
      /display\s*:\s*none/i.test(style)
    );
  }

  return {
    PowerParseError,
    normalizePowerLevel,
    parsePowerElement,
    validatePowerData
  };
});
