import * as core from '@actions/core'

// core.debug() writes to stdout even when debug logging is disabled;
// unguarded per-file logging can crash Node on huge file sets (issue #124)
export function debug(message: string): void {
  if (core.isDebug()) {
    core.debug(message)
  }
}
