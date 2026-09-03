const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const {
  PowerParseError,
  normalizePowerLevel,
  parsePowerElement
} = require("../src/power-parser");

function loadFixture(name) {
  const fixturePath = path.join(__dirname, "fixtures", name);
  const html = readFileSync(fixturePath, "utf8");
  const dom = new JSDOM(html);

  return dom.window.document;
}

function parseFixture(name, selector = ".v-expansion-panel") {
  const document = loadFixture(name);

  return parsePowerElement(document.querySelector(selector));
}

test("parses a complete normal N7 power into structured data", () => {
  const power = parseFixture("complete-power.html");

  assert.deepEqual(power, {
    name: "Cryo Blast",
    level: 1,
    school: "Tech",
    castingTime: "1 action",
    duration: "Instantaneous",
    concentration: false,
    range: "60 feet",
    primes: true,
    detonates: true,
    attackType: "Ranged",
    damageEffect: "Cold",
    description:
      "You snap-freeze a target in range, dealing cold damage and slowing its movement.\nThe target has disadvantage on its next Dexterity saving throw before the end of your next turn.",
    higherLevels: "The cold damage increases by 1d6 for each slot level above 1st.",
    advancementOptions: [
      {
        title: "Frozen Vulnerability",
        description: "Primed targets take additional damage from the next detonation."
      },
      {
        title: "Radius Burst",
        description: "The power can affect creatures within 5 feet of the target."
      }
    ]
  });
});

test("parses a cantrip as level 0 and preserves concentration", () => {
  const power = parseFixture("cantrip-power.html");

  assert.equal(power.name, "Biotic Spark");
  assert.equal(power.level, 0);
  assert.equal(power.school, "Biotic");
  assert.equal(power.duration, "Up to 1 minute");
  assert.equal(power.concentration, true);
  assert.equal(power.primes, true);
  assert.equal(power.detonates, false);
  assert.equal(power.attackType, "");
  assert.equal(power.damageEffect, "");
});

test("reads the power name from the expansion-panel header when no heading class exists", () => {
  const dom = new JSDOM(`
    <article class="v-expansion-panel">
      <button class="v-expansion-panel-header" aria-expanded="true">
        Overload
        <button class="n7-roll20-bridge-copy-button">Copy Power</button>
      </button>
      <div class="col-md-3 col-6"><div class="text-caption">Level</div><div class="text-body-2">1</div></div>
      <div class="me-html text-body-2"><p>Disrupts shields and synthetic targets.</p></div>
    </article>
  `);
  const power = parsePowerElement(dom.window.document.querySelector(".v-expansion-panel"));

  assert.equal(power.name, "Overload");
});

test("normalizes numeric power levels 1-5", () => {
  const document = loadFixture("levelled-powers.html");
  const powers = Array.from(document.querySelectorAll(".v-expansion-panel")).map((element) =>
    parsePowerElement(element)
  );

  assert.deepEqual(
    powers.map((power) => power.level),
    [1, 2, 3, 4, 5]
  );
});

test("reads fourth-level ordinal text from N7 stat cards", () => {
  const dom = new JSDOM(`
    <article class="v-expansion-panel">
      <span class="text-h6">Tactical Cloak</span>
      <div class="col-md-3 col-6">
        <div class="text-caption">4th</div>
        <div class="text-body-2">Level</div>
      </div>
      <div class="me-html text-body-2"><p>You become difficult to detect.</p></div>
    </article>
  `);
  const power = parsePowerElement(dom.window.document.querySelector(".v-expansion-panel"));

  assert.equal(power.level, 4);
});

test("normalizes written power level names", () => {
  assert.equal(normalizePowerLevel("Fourth Level"), 4);
  assert.equal(normalizePowerLevel("Level Four"), 4);
});

test("extracts casting time, duration, range, attack, damage, and text fields", () => {
  const power = parseFixture("complete-power.html");

  assert.equal(power.castingTime, "1 action");
  assert.equal(power.duration, "Instantaneous");
  assert.equal(power.range, "60 feet");
  assert.equal(power.attackType, "Ranged");
  assert.equal(power.damageEffect, "Cold");
  assert.match(power.description, /snap-freeze/);
  assert.match(power.higherLevels, /damage increases/);
});

test("normalizes hard-wrapped duplicate description text", () => {
  const dom = new JSDOM(`
    <article class="v-expansion-panel">
      <span class="text-h6">AI Hacking</span>
      <div class="col-md-3 col-6"><div class="text-caption">Level</div><div class="text-body-2">3</div></div>
      <div class="me-html text-body-2">
        <p>
          Target a synthetic creature within 36 meters. It must succeed on an Intelligence saving throw or it becomes Hacked (it is considered
          charmed and can't use powers or abilities). If you or creatures that are friendly to you are fighting it, it has advantage
          on the saving throw.
        </p>
        <p>
          On its turn, the hacked creature attacks the closest creature hostile to the power caster, making a ranged weapon
          attack or melee attack if it does not have a weapon.
        </p>
        <p>
          Target a synthetic creature within 36 meters. It must succeed on an Intelligence saving throw or it becomes Hacked (it is considered
          charmed and can't use powers or abilities). If you or creatures that are friendly to you are fighting it, it has advantage
          on the saving throw.
        </p>
        <p>
          On its turn, the hacked creature attacks the closest creature hostile to the power caster, making a ranged weapon
          attack or melee attack if it does not have a weapon.
        </p>
      </div>
    </article>
  `);
  const power = parsePowerElement(dom.window.document.querySelector(".v-expansion-panel"));

  assert.equal(
    power.description,
    "Target a synthetic creature within 36 meters. It must succeed on an Intelligence saving throw or it becomes Hacked (it is considered charmed and can't use powers or abilities). If you or creatures that are friendly to you are fighting it, it has advantage on the saving throw.\nOn its turn, the hacked creature attacks the closest creature hostile to the power caster, making a ranged weapon attack or melee attack if it does not have a weapon."
  );
});

test("handles primes only", () => {
  const power = parseFixture("cantrip-power.html");

  assert.equal(power.primes, true);
  assert.equal(power.detonates, false);
});

test("handles detonates only", () => {
  const dom = new JSDOM(`
    <article class="v-expansion-panel">
      <span class="text-h6">Disruptor Pulse</span>
      <div class="col-md-3 col-6"><div class="text-caption">Level</div><div class="text-body-2">1</div></div>
      <div class="col-md-3 col-6"><div class="text-caption">Combo</div><div class="text-body-2">Detonates</div></div>
      <div class="me-html text-body-2"><p>A sharp pulse overloads a primed target.</p></div>
    </article>
  `);
  const power = parsePowerElement(dom.window.document.querySelector(".v-expansion-panel"));

  assert.equal(power.primes, false);
  assert.equal(power.detonates, true);
});

test("handles powers that both prime and detonate", () => {
  const power = parseFixture("complete-power.html");

  assert.equal(power.primes, true);
  assert.equal(power.detonates, true);
});

test("parses advancement options without treating higher-level text as an advancement", () => {
  const power = parseFixture("complete-power.html");

  assert.equal(power.advancementOptions.length, 2);
  assert.deepEqual(power.advancementOptions[0], {
    title: "Frozen Vulnerability",
    description: "Primed targets take additional damage from the next detonation."
  });
});

test("allows optional values to be missing", () => {
  const power = parseFixture("minimal-power.html");

  assert.deepEqual(power, {
    name: "Tactical Scan",
    level: 2,
    school: "Tech",
    castingTime: "",
    duration: "",
    concentration: false,
    range: "",
    primes: false,
    detonates: false,
    attackType: "",
    damageEffect: "",
    description: "You quickly analyze a hostile target.",
    higherLevels: "",
    advancementOptions: []
  });
});

test("throws a parser error for an empty or malformed power element", () => {
  const document = loadFixture("malformed-power.html");

  assert.throws(
    () => parsePowerElement(document.querySelector(".v-expansion-panel")),
    /Could not read the power name/
  );
});

test("throws a parser error for unsupported levels", () => {
  const document = loadFixture("invalid-level-power.html");

  assert.throws(
    () => parsePowerElement(document.querySelector(".v-expansion-panel")),
    (error) => error instanceof PowerParseError && /Unsupported power level/.test(error.message)
  );
});

test("normalizes cantrip and rejects invalid level text directly", () => {
  assert.equal(normalizePowerLevel("Cantrip"), 0);
  assert.equal(normalizePowerLevel("Level 5"), 5);
  assert.throws(() => normalizePowerLevel("Mythic"), /Unsupported power level/);
});
