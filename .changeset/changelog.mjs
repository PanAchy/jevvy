import githubChangelog from "@changesets/changelog-github"

const authorPattern = /^\[@([^\]]+)\]\([^)]+\)$/u

const thanksPattern = / Thanks ((?:\[@[^\]]+\]\([^)]+\))(?:, \[@[^\]]+\]\([^)]+\))*)!/u

export function omitIgnoredThanks(line, ignoredAuthors) {
  const ignored = new Set(ignoredAuthors.map((author) => author.toLowerCase()))

  return line.replace(thanksPattern, (_thanks, authors) => {
    const visibleAuthors = authors.split(", ").filter((author) => {
      const login = authorPattern.exec(author)?.[1]

      return login === undefined || !ignored.has(login.toLowerCase())
    })

    return visibleAuthors.length === 0 ? "" : ` Thanks ${visibleAuthors.join(", ")}!`
  })
}

async function getReleaseLine(changeset, type, options = {}) {
  const { ignoreAuthors = [], ...githubOptions } = options
  const line = await githubChangelog.getReleaseLine(changeset, type, githubOptions)

  return omitIgnoredThanks(line, ignoreAuthors)
}

const changelog = {
  getReleaseLine,
  getDependencyReleaseLine: githubChangelog.getDependencyReleaseLine,
}

export default changelog
