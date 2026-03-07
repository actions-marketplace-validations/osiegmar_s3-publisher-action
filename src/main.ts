import * as core from '@actions/core'
import * as fs from 'fs'
import { performance } from 'perf_hooks'
import { globFilter, listLocalFiles, sortByGlob } from './local.js'
import { S3 } from './s3.js'
import {
  CacheControl,
  RemoteFile,
  RemoteFiles,
  SyncFile,
  dryRunPrefix,
  formatElapsed,
  formatSize
} from './types.js'

export type SyncInputs = {
  bucket: string
  prefix: string
  srcDir: string
  includes: string[]
  excludes: string[]
  order: string[]
  cacheControl: CacheControl[]
  force: boolean
  deleteOrphan: boolean
  waitBeforeDelete: number
  dryRun: boolean
}

export async function run(): Promise<void> {
  try {
    await sync()
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

async function sync(): Promise<void> {
  const syncStart = performance.now()

  const config = readInputs()
  const client = new S3(
    config.bucket,
    config.prefix,
    config.cacheControl,
    config.dryRun
  )

  core.info(`Configuration:
  Bucket: ${config.bucket}
  Prefix: ${config.prefix || '(none)'}
  Source dir: ${config.srcDir}
  Includes: ${config.includes.join(', ')}
  Excludes: ${config.excludes.join(', ') || '(none)'}
  Force upload: ${config.force}
  Delete orphaned: ${config.deleteOrphan}
  Wait before delete: ${config.waitBeforeDelete}ms
  Dry run: ${config.dryRun}
  Cache-control rules: ${config.cacheControl.length}`)

  // 1) List phase
  let syncFiles: SyncFile[]
  let remoteFiles: RemoteFiles
  core.startGroup('Listing files')
  try {
    const remoteFilesPromise: Promise<RemoteFiles> = client.listRemoteFiles()

    process.chdir(config.srcDir)
    const allLocalFiles = listLocalFiles('.')

    if (allLocalFiles.length === 0) {
      throw new Error(`Source directory is empty: ${config.srcDir}`)
    }

    const filter = globFilter(config.includes, config.excludes)

    syncFiles = allLocalFiles.filter(filter).map((f) => new SyncFile(f))
    core.info(
      `Found ${syncFiles.length} relevant local files` +
        (syncFiles.length !== allLocalFiles.length
          ? ` (filtered from ${allLocalFiles.length} total)`
          : '')
    )

    const allRemoteFiles = await remoteFilesPromise
    remoteFiles = Object.fromEntries(
      Object.entries(allRemoteFiles).filter(([key]) => filter(key))
    )
    const allRemoteCount = Object.keys(allRemoteFiles).length
    const remoteCount = Object.keys(remoteFiles).length
    core.info(
      `Found ${remoteCount} relevant remote files` +
        (remoteCount !== allRemoteCount
          ? ` (filtered from ${allRemoteCount} total)`
          : '')
    )
  } finally {
    core.endGroup()
  }

  // 2) Check phase
  const { newFiles, modifiedFiles, deletedFiles } = diffFiles(
    syncFiles,
    remoteFiles,
    config
  )

  const unchangedCount =
    syncFiles.length - newFiles.length - modifiedFiles.length
  const dryPrefix = dryRunPrefix(config.dryRun)
  core.info(
    `${dryPrefix}Sync summary:` +
      ` ${newFiles.length} new, ${modifiedFiles.length} modified,` +
      ` ${deletedFiles.length} deleted, ${unchangedCount} unchanged`
  )

  if (deletedFiles.length > 0 && !config.deleteOrphan) {
    core.warning(
      `${deletedFiles.length} orphaned files would be deleted` +
        ` if 'delete-orphaned' were enabled`
    )
  }

  // 3) Sync phase
  await applyChanges(
    client,
    newFiles,
    modifiedFiles,
    config.deleteOrphan ? deletedFiles : [],
    config
  )

  core.info(
    `${dryPrefix}Sync completed in ${formatElapsed(performance.now() - syncStart)}`
  )
}

export function readInputs(): SyncInputs {
  const bucket = core.getInput('bucket', { required: true })
  const prefix = core.getInput('prefix')
  const srcDir = core.getInput('dir', { required: true })
  const includes = core.getMultilineInput('includes', { required: true })
  const excludes = core.getMultilineInput('excludes')
  const orderInput = core.getInput('order')
  const order = orderInput ? orderInput.split(',') : []
  const cacheControl = readCacheControlConfig(
    core.getMultilineInput('cache-control')
  )
  const force = core.getBooleanInput('force-upload', { required: true })
  const deleteOrphan = core.getBooleanInput('delete-orphaned', {
    required: true
  })
  const waitBeforeDeleteRaw = core.getInput('wait-before-delete')
  let waitBeforeDelete = Number(waitBeforeDeleteRaw)
  if (waitBeforeDeleteRaw && Number.isNaN(waitBeforeDelete)) {
    core.warning(
      `Invalid wait-before-delete value '${waitBeforeDeleteRaw}', defaulting to 0`
    )
    waitBeforeDelete = 0
  }
  const dryRun = core.getBooleanInput('dry-run', { required: true })

  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`Source directory does not exist: ${srcDir}`)
  }

  return {
    bucket,
    prefix,
    srcDir,
    includes,
    excludes,
    order,
    cacheControl,
    force,
    deleteOrphan,
    waitBeforeDelete,
    dryRun
  }
}

export function readCacheControlConfig(config: string[]): CacheControl[] {
  const ret: CacheControl[] = []

  for (const line of config) {
    const idx = line.indexOf('=')
    if (idx === -1) {
      core.warning(`Invalid cache-control config (missing '='): ${line}`)
      continue
    }
    ret.push({
      glob: line.substring(0, idx).trim(),
      headerValue: line.substring(idx + 1).trim()
    })
  }

  return ret
}

export function diffFiles(
  syncFiles: SyncFile[],
  remoteFiles: RemoteFiles,
  config: SyncInputs
): { newFiles: SyncFile[]; modifiedFiles: SyncFile[]; deletedFiles: string[] } {
  const newFiles: SyncFile[] = []
  const modifiedFiles: SyncFile[] = []
  const localFilenames = new Set<string>()

  // Determine new and modified files
  for (const syncFile of syncFiles) {
    const localFilename = syncFile.filename
    localFilenames.add(localFilename)
    const remoteFile = remoteFiles[localFilename]
    if (!remoteFile) {
      core.debug(`Add new file to list ${localFilename}`)
      newFiles.push(syncFile)
    } else if (config.force) {
      core.debug(`Add file to list (force upload) ${localFilename}`)
      modifiedFiles.push(syncFile)
    } else {
      const reason = fileChangeReason(syncFile, remoteFile)
      if (reason) {
        core.debug(`Modified (${reason}): ${localFilename}`)
        modifiedFiles.push(syncFile)
      } else {
        core.debug(`Unchanged: ${localFilename}`)
      }
    }
  }

  // Determine orphaned files (always, regardless of deleteOrphan setting)
  const deletedFiles: string[] = []
  for (const remoteFile of Object.keys(remoteFiles)) {
    if (!localFilenames.has(remoteFile)) {
      core.debug(`Add orphaned file to list ${remoteFile}`)
      deletedFiles.push(remoteFile)
    }
  }

  return { newFiles, modifiedFiles, deletedFiles }
}

export async function applyChanges(
  client: S3,
  newFiles: SyncFile[],
  modifiedFiles: SyncFile[],
  deletedFiles: string[],
  config: SyncInputs
): Promise<void> {
  const dryPrefix = dryRunPrefix(config.dryRun)

  if (newFiles.length > 0) {
    await uploadBatch(client, newFiles, 'new', config, dryPrefix)
  }

  if (modifiedFiles.length > 0) {
    await uploadBatch(client, modifiedFiles, 'modified', config, dryPrefix)
  }

  if (deletedFiles.length > 0) {
    core.startGroup(
      `${dryPrefix}Deleting ${deletedFiles.length} orphaned files`
    )
    try {
      if (!config.dryRun && config.waitBeforeDelete) {
        core.info(
          `Wait ${config.waitBeforeDelete} milliseconds before deleting files (prevent failed access to stale references)`
        )
        await new Promise((r) => setTimeout(r, config.waitBeforeDelete))
      }
      const start = performance.now()
      await client.deleteFiles(deletedFiles)
      core.info(
        `${dryPrefix}Deleted ${deletedFiles.length} orphaned files in ${formatElapsed(performance.now() - start)}`
      )
    } finally {
      core.endGroup()
    }
  }
}

async function uploadBatch(
  client: S3,
  files: SyncFile[],
  label: string,
  config: SyncInputs,
  dryPrefix: string
): Promise<void> {
  core.startGroup(`${dryPrefix}Uploading ${files.length} ${label} files`)
  try {
    const start = performance.now()
    await client.uploadFiles(sortByGlob(files, config.order))
    const totalSize = files.reduce((sum, f) => sum + f.size, 0)
    const elapsed = formatElapsed(performance.now() - start)
    core.info(
      `${dryPrefix}Uploaded ${files.length} ${label} files` +
        ` (${formatSize(totalSize)}) in ${elapsed}`
    )
  } finally {
    core.endGroup()
  }
}

export function fileChangeReason(
  syncFile: SyncFile,
  remoteFile: RemoteFile
): string | undefined {
  if (syncFile.size !== remoteFile.size) {
    return `size: ${remoteFile.size} -> ${syncFile.size}`
  }
  if (syncFile.checksum !== remoteFile.etag) {
    return 'content changed'
  }
  return undefined
}
