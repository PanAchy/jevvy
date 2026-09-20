#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const titleCase = (value) =>
  value
    .replace(/^@/u, "")
    .split(/[/_-]/u)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ")

export const formatReleaseTitle = ({ name, version }) => `${titleCase(name)} ${version}`

const renameGithubReleases = () => {
  const input = process.env.PUBLISHED_PACKAGES

  if (input === undefined) throw new Error("PUBLISHED_PACKAGES is required")

  const publishedPackages = JSON.parse(input)

  if (!Array.isArray(publishedPackages)) throw new Error("PUBLISHED_PACKAGES must be a JSON array")

  for (const publishedPackage of publishedPackages) {
    const { name, version } = publishedPackage

    execFileSync("gh", ["release", "edit", `${name}@${version}`, "--title", formatReleaseTitle(publishedPackage)], {
      stdio: "inherit",
    })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  renameGithubReleases()
}
