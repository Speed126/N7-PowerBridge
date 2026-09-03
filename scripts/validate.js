"use strict";

const { existsSync, readFileSync } = require("node:fs");
const { readdir } = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const checkedJavaScriptDirectories = ["src", "tests", "scripts"];

async function main() {
  validateManifest();
  await validateJavaScriptSyntax();
}

function validateManifest() {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const referencedFiles = new Set();

  collectManifestFiles(manifest.background, referencedFiles);
  collectManifestFiles(manifest.action, referencedFiles);
  collectContentScriptFiles(manifest.content_scripts, referencedFiles);
  collectIconFiles(manifest.icons, referencedFiles);

  for (const file of referencedFiles) {
    const absolutePath = path.join(root, file);

    if (!existsSync(absolutePath)) {
      throw new Error(`manifest.json references missing file: ${file}`);
    }
  }
}

function collectManifestFiles(value, files) {
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && isLocalFileReference(key, child)) {
      files.add(child);
    } else if (Array.isArray(child)) {
      child.filter((item) => typeof item === "string").forEach((item) => files.add(item));
    } else {
      collectManifestFiles(child, files);
    }
  }
}

function collectContentScriptFiles(contentScripts, files) {
  if (!Array.isArray(contentScripts)) {
    return;
  }

  for (const contentScript of contentScripts) {
    for (const key of ["js", "css"]) {
      const entries = contentScript[key];

      if (Array.isArray(entries)) {
        entries.forEach((entry) => files.add(entry));
      }
    }
  }
}

function collectIconFiles(icons, files) {
  if (!icons || typeof icons !== "object") {
    return;
  }

  Object.values(icons)
    .filter((value) => typeof value === "string")
    .forEach((value) => files.add(value));
}

function isLocalFileReference(key, value) {
  return (
    ["service_worker", "default_popup", "default_icon", "default_path"].includes(key) &&
    !value.startsWith("http://") &&
    !value.startsWith("https://")
  );
}

async function validateJavaScriptSyntax() {
  const files = [];

  for (const directory of checkedJavaScriptDirectories) {
    files.push(...(await listJavaScriptFiles(path.join(root, directory))));
  }

  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      cwd: root,
      encoding: "utf8"
    });

    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      throw new Error(`JavaScript syntax check failed: ${path.relative(root, file)}`);
    }
  }
}

async function listJavaScriptFiles(directory) {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(absolutePath);
    }
  }

  return files;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
