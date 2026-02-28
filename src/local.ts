import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import picomatch from 'picomatch'
import { GLOB_OPTIONS, SyncFile } from './types.js'

export function listLocalFiles(
  dirPath: string,
  results: string[] = []
): string[] {
  for (const file of fs.readdirSync(dirPath)) {
    const fullPath = path.join(dirPath, file)
    const stats = fs.lstatSync(fullPath)
    if (stats.isDirectory()) {
      listLocalFiles(fullPath, results)
    } else if (stats.isFile()) {
      results.push(fullPath)
    }
  }

  return results
}

export function globFilter(
  includes: string[],
  excludes: string[]
): (p: string) => boolean {
  const excludeMatchers = excludes.map((e) => ({
    pattern: e,
    match: picomatch(e, GLOB_OPTIONS)
  }))
  const includeMatchers = includes.map((i) => ({
    pattern: i,
    match: picomatch(i, GLOB_OPTIONS)
  }))
  return (p: string) => {
    for (const { pattern, match } of excludeMatchers) {
      if (match(p)) {
        core.debug(`File ${p} excluded by exclude glob ${pattern}`)
        return false
      }
    }
    for (const { pattern, match } of includeMatchers) {
      if (match(p)) {
        core.debug(`File ${p} included by include glob ${pattern}`)
        return true
      }
    }
    core.debug(`File ${p} excluded (no glob matched)`)
    return false
  }
}

export function sortByGlob(files: SyncFile[], order: string[]): SyncFile[] {
  const matchers = order.filter((g) => g).map((g) => picomatch(g, GLOB_OPTIONS))
  return files.toSorted(
    (a, b) =>
      matcherSortOrder(a.filename, matchers) -
      matcherSortOrder(b.filename, matchers)
  )
}

function matcherSortOrder(
  filename: string,
  matchers: ((input: string) => boolean)[]
): number {
  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i](filename)) {
      return i
    }
  }
  return matchers.length
}
