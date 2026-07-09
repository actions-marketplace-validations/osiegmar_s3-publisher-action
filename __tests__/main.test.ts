import { jest } from '@jest/globals'

const mockDebug = jest.fn()
const mockIsDebug = jest.fn().mockReturnValue(false)
const mockInfo = jest.fn()
const mockWarning = jest.fn()
const mockStartGroup = jest.fn()
const mockEndGroup = jest.fn()
const mockGetInput = jest.fn().mockReturnValue('')
const mockGetMultilineInput = jest.fn().mockReturnValue([])
const mockGetBooleanInput = jest.fn().mockReturnValue(false)
const mockSetFailed = jest.fn()

const mockExistsSync = jest.fn()
const mockReaddirSync = jest.fn()
const mockLstatSync = jest.fn()
const mockStatSync = jest.fn()
const mockGenerateETag = jest.fn()
const mockListRemoteFiles = jest.fn().mockResolvedValue({})
const mockUploadFiles = jest.fn().mockResolvedValue(undefined)
const mockDeleteFiles = jest.fn().mockResolvedValue(undefined)

jest.unstable_mockModule('@actions/core', () => ({
  debug: mockDebug,
  isDebug: mockIsDebug,
  info: mockInfo,
  warning: mockWarning,
  startGroup: mockStartGroup,
  endGroup: mockEndGroup,
  getInput: mockGetInput,
  getMultilineInput: mockGetMultilineInput,
  getBooleanInput: mockGetBooleanInput,
  setFailed: mockSetFailed
}))

jest.unstable_mockModule('../src/s3.js', () => ({
  S3: jest.fn().mockImplementation(() => ({
    listRemoteFiles: mockListRemoteFiles,
    uploadFiles: mockUploadFiles,
    deleteFiles: mockDeleteFiles
  }))
}))

jest.unstable_mockModule('fs', () => ({
  default: {
    existsSync: mockExistsSync,
    readdirSync: mockReaddirSync,
    lstatSync: mockLstatSync,
    statSync: mockStatSync
  },
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
  lstatSync: mockLstatSync,
  statSync: mockStatSync
}))

jest.unstable_mockModule('s3-etag', () => ({
  generateETag: mockGenerateETag
}))

const {
  run,
  readInputs,
  readCacheControlConfig,
  fileChangeReason,
  diffFiles,
  applyChanges
} = await import('../src/main.js')
type SyncInputs = import('../src/main.js').SyncInputs
const { SyncFile } = await import('../src/types.js')
const { S3: S3Mock } = await import('../src/s3.js')

describe('readInputs', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => true })
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'bucket') return 'my-bucket'
      if (name === 'prefix') return 'assets/'
      if (name === 'dir') return '/build'
      if (name === 'order') return '*.html,*.js'
      return ''
    })
    mockGetMultilineInput.mockImplementation((name: string) => {
      if (name === 'includes') return ['**/*']
      if (name === 'excludes') return ['.gitignore']
      if (name === 'cache-control') return ['*.html=no-cache']
      return []
    })
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === 'force-upload') return true
      if (name === 'delete-orphaned') return true
      if (name === 'dry-run') return false
      return false
    })
  })

  it('should read all inputs', () => {
    const inputs: SyncInputs = readInputs()

    expect(inputs.bucket).toBe('my-bucket')
    expect(inputs.prefix).toBe('assets/')
    expect(inputs.srcDir).toBe('/build')
    expect(inputs.includes).toEqual(['**/*'])
    expect(inputs.excludes).toEqual(['.gitignore'])
    expect(inputs.order).toEqual(['*.html', '*.js'])
    expect(inputs.cacheControl).toEqual([
      { glob: '*.html', headerValue: 'no-cache' }
    ])
    expect(inputs.force).toBe(true)
    expect(inputs.deleteOrphan).toBe(true)
    expect(inputs.waitBeforeDelete).toBe(0)
    expect(inputs.dryRun).toBe(false)
  })

  it('should parse wait-before-delete as number', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'bucket') return 'b'
      if (name === 'dir') return '/d'
      if (name === 'wait-before-delete') return '5000'
      return ''
    })

    expect(readInputs().waitBeforeDelete).toBe(5000)
  })

  it('should default wait-before-delete to 0 on invalid value', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'bucket') return 'b'
      if (name === 'dir') return '/d'
      if (name === 'wait-before-delete') return 'abc'
      return ''
    })

    expect(readInputs().waitBeforeDelete).toBe(0)
    expect(mockWarning).toHaveBeenCalledWith(
      "Invalid wait-before-delete value 'abc', defaulting to 0"
    )
  })

  it('should return empty order when input is empty', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'bucket') return 'b'
      if (name === 'dir') return '/d'
      return ''
    })

    expect(readInputs().order).toEqual([])
  })
})

describe('readCacheControlConfig', () => {
  it('should parse glob=value lines', () => {
    const result = readCacheControlConfig([
      '*.html=max-age=3600',
      '*.js=no-cache'
    ])
    expect(result).toHaveLength(2)
    expect(result[0].glob).toBe('*.html')
    expect(result[0].headerValue).toBe('max-age=3600')
    expect(result[1].glob).toBe('*.js')
    expect(result[1].headerValue).toBe('no-cache')
  })

  it('should handle empty array', () => {
    const result = readCacheControlConfig([])
    expect(result).toHaveLength(0)
  })

  it('should trim whitespace around glob and value', () => {
    const result = readCacheControlConfig([' *.css = public, max-age=86400 '])
    expect(result[0].glob).toBe('*.css')
    expect(result[0].headerValue).toBe('public, max-age=86400')
  })

  it('should warn and skip lines without =', () => {
    const result = readCacheControlConfig([
      'no-equals-here',
      '*.html=max-age=3600',
      ''
    ])
    expect(result).toHaveLength(1)
    expect(result[0].glob).toBe('*.html')
    expect(mockWarning).toHaveBeenCalledTimes(2)
    expect(mockWarning).toHaveBeenCalledWith(
      "Invalid cache-control config (missing '='): no-equals-here"
    )
  })
})

describe('fileChangeReason', () => {
  it('should return undefined when both size and etag match', () => {
    mockStatSync.mockReturnValue({ size: 100 })
    mockGenerateETag.mockReturnValue('abc123')
    const syncFile = new SyncFile('file.txt')
    expect(
      fileChangeReason(syncFile, { size: 100, etag: 'abc123' })
    ).toBeUndefined()
  })

  it('should return size reason when size differs', () => {
    mockStatSync.mockReturnValue({ size: 200 })
    const syncFile = new SyncFile('file.txt')
    expect(fileChangeReason(syncFile, { size: 100, etag: 'abc123' })).toBe(
      'size: 100 -> 200'
    )
  })

  it('should return content reason when etag differs', () => {
    mockStatSync.mockReturnValue({ size: 100 })
    mockGenerateETag.mockReturnValue('different')
    const syncFile = new SyncFile('file.txt')
    expect(fileChangeReason(syncFile, { size: 100, etag: 'abc123' })).toBe(
      'content changed'
    )
  })
})

describe('diffFiles', () => {
  function makeSyncFile(
    filename: string,
    size: number,
    checksum: string
  ): SyncFile {
    const sf = new SyncFile(filename)
    Object.defineProperty(sf, 'size', { get: () => size })
    Object.defineProperty(sf, 'checksum', { get: () => checksum })
    return sf
  }

  function makeConfig(overrides: Partial<SyncInputs> = {}): SyncInputs {
    return {
      bucket: 'test',
      prefix: '',
      srcDir: '.',
      includes: ['**/*'],
      excludes: [],
      order: [],
      cacheControl: [],
      force: false,
      deleteOrphan: false,
      waitBeforeDelete: 0,
      dryRun: false,
      ...overrides
    }
  }

  it('should detect new files not present in remote', () => {
    const local = [makeSyncFile('new.html', 100, 'abc')]
    const result = diffFiles(local, {}, makeConfig())

    expect(result.newFiles).toHaveLength(1)
    expect(result.newFiles[0].filename).toBe('new.html')
    expect(result.modifiedFiles).toHaveLength(0)
    expect(result.deletedFiles).toHaveLength(0)
  })

  it('should detect modified files by size change', () => {
    const local = [makeSyncFile('page.html', 200, 'abc')]
    const remoteFiles = {
      'page.html': { size: 100, etag: 'abc' }
    }

    const result = diffFiles(local, remoteFiles, makeConfig())

    expect(result.newFiles).toHaveLength(0)
    expect(result.modifiedFiles).toHaveLength(1)
    expect(result.modifiedFiles[0].filename).toBe('page.html')
  })

  it('should detect modified files by etag change', () => {
    const local = [makeSyncFile('page.html', 100, 'xyz')]
    const remoteFiles = {
      'page.html': { size: 100, etag: 'abc' }
    }

    const result = diffFiles(local, remoteFiles, makeConfig())

    expect(result.newFiles).toHaveLength(0)
    expect(result.modifiedFiles).toHaveLength(1)
  })

  it('should detect unchanged files', () => {
    const local = [makeSyncFile('page.html', 100, 'abc')]
    const remoteFiles = {
      'page.html': { size: 100, etag: 'abc' }
    }

    const result = diffFiles(local, remoteFiles, makeConfig())

    expect(result.newFiles).toHaveLength(0)
    expect(result.modifiedFiles).toHaveLength(0)
    expect(result.deletedFiles).toHaveLength(0)
  })

  it('should mark all existing files as modified when force=true', () => {
    const local = [
      makeSyncFile('a.html', 100, 'abc'),
      makeSyncFile('b.html', 200, 'def')
    ]
    const remoteFiles = {
      'a.html': { size: 100, etag: 'abc' },
      'b.html': { size: 200, etag: 'def' }
    }

    const result = diffFiles(local, remoteFiles, makeConfig({ force: true }))

    expect(result.newFiles).toHaveLength(0)
    expect(result.modifiedFiles).toHaveLength(2)
  })

  it('should detect orphaned files', () => {
    const local = [makeSyncFile('a.html', 100, 'abc')]
    const remoteFiles = {
      'a.html': { size: 100, etag: 'abc' },
      'old.html': { size: 50, etag: 'xyz' }
    }

    const result = diffFiles(local, remoteFiles, makeConfig())

    expect(result.deletedFiles).toEqual(['old.html'])
  })

  it('should not debug-log files when debug logging is disabled', () => {
    const local = [makeSyncFile('new.html', 100, 'abc')]
    const remoteFiles = {
      'orphan.html': { size: 50, etag: 'xyz' }
    }

    diffFiles(local, remoteFiles, makeConfig())

    expect(mockDebug).not.toHaveBeenCalled()
  })

  it('should never log per orphaned file, even in debug mode', () => {
    mockIsDebug.mockReturnValue(true)
    try {
      const remoteFiles = {
        'orphan1.html': { size: 50, etag: 'xyz' },
        'orphan2.html': { size: 60, etag: 'abc' }
      }

      const result = diffFiles([], remoteFiles, makeConfig())

      expect(result.deletedFiles).toHaveLength(2)
      expect(mockDebug).not.toHaveBeenCalled()
    } finally {
      mockIsDebug.mockReturnValue(false)
    }
  })

  it('should handle mixed new, modified, unchanged, and orphaned', () => {
    const local = [
      makeSyncFile('new.html', 100, 'aaa'),
      makeSyncFile('modified.html', 300, 'bbb'),
      makeSyncFile('unchanged.html', 200, 'ccc')
    ]
    const remoteFiles = {
      'modified.html': { size: 200, etag: 'ccc' },
      'unchanged.html': { size: 200, etag: 'ccc' },
      'orphan.html': { size: 50, etag: 'ddd' }
    }

    const result = diffFiles(local, remoteFiles, makeConfig())

    expect(result.newFiles).toHaveLength(1)
    expect(result.newFiles[0].filename).toBe('new.html')
    expect(result.modifiedFiles).toHaveLength(1)
    expect(result.modifiedFiles[0].filename).toBe('modified.html')
    expect(result.deletedFiles).toEqual(['orphan.html'])
  })
})

describe('applyChanges', () => {
  function makeSyncFile(filename: string): SyncFile {
    const sf = new SyncFile(filename)
    Object.defineProperty(sf, 'size', { get: () => 100 })
    return sf
  }

  function makeClient(): S3Mock {
    return new S3Mock('test', '', [])
  }

  function makeConfig(overrides: Partial<SyncInputs> = {}): SyncInputs {
    return {
      bucket: 'test',
      prefix: '',
      srcDir: '.',
      includes: ['**/*'],
      excludes: [],
      order: [''],
      cacheControl: [],
      force: false,
      deleteOrphan: false,
      waitBeforeDelete: 0,
      dryRun: false,
      ...overrides
    }
  }

  it('should upload new files', async () => {
    await applyChanges(
      makeClient(),
      [makeSyncFile('a.html')],
      [],
      [],
      makeConfig()
    )

    expect(mockUploadFiles).toHaveBeenCalledTimes(1)
    expect(mockDeleteFiles).not.toHaveBeenCalled()
  })

  it('should upload modified files', async () => {
    await applyChanges(
      makeClient(),
      [],
      [makeSyncFile('a.html')],
      [],
      makeConfig()
    )

    expect(mockUploadFiles).toHaveBeenCalledTimes(1)
    expect(mockDeleteFiles).not.toHaveBeenCalled()
  })

  it('should delete orphaned files', async () => {
    await applyChanges(makeClient(), [], [], ['old.html'], makeConfig())

    expect(mockUploadFiles).not.toHaveBeenCalled()
    expect(mockDeleteFiles).toHaveBeenCalledWith(['old.html'])
  })

  it('should do nothing when all arrays are empty', async () => {
    await applyChanges(makeClient(), [], [], [], makeConfig())

    expect(mockUploadFiles).not.toHaveBeenCalled()
    expect(mockDeleteFiles).not.toHaveBeenCalled()
  })

  it('should handle combined new, modified, and deleted', async () => {
    await applyChanges(
      makeClient(),
      [makeSyncFile('new.html')],
      [makeSyncFile('mod.html')],
      ['old.html'],
      makeConfig()
    )

    expect(mockUploadFiles).toHaveBeenCalledTimes(2)
    expect(mockDeleteFiles).toHaveBeenCalledWith(['old.html'])
  })

  it('should wait before deleting when not dry-run', async () => {
    jest.useFakeTimers()

    const promise = applyChanges(
      makeClient(),
      [],
      [],
      ['old.html'],
      makeConfig({ waitBeforeDelete: 5000 })
    )

    expect(mockDeleteFiles).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(5000)
    await promise

    expect(mockDeleteFiles).toHaveBeenCalledWith(['old.html'])

    jest.useRealTimers()
  })

  it('should skip wait in dry-run mode', async () => {
    await applyChanges(
      makeClient(),
      [],
      [],
      ['old.html'],
      makeConfig({ waitBeforeDelete: 5000, dryRun: true })
    )

    expect(mockDeleteFiles).toHaveBeenCalledWith(['old.html'])
  })

  it('should sort files by glob order before uploading', async () => {
    const files = [
      makeSyncFile('style.css'),
      makeSyncFile('index.html'),
      makeSyncFile('app.js')
    ]

    await applyChanges(
      makeClient(),
      files,
      [],
      [],
      makeConfig({ order: ['*.html', '*.js', '*.css'] })
    )

    const uploaded = mockUploadFiles.mock.calls[0][0]
    expect(uploaded[0].filename).toBe('index.html')
    expect(uploaded[1].filename).toBe('app.js')
    expect(uploaded[2].filename).toBe('style.css')
  })
})

describe('run', () => {
  let mockChdir: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    jest.clearAllMocks()
    mockChdir = jest.spyOn(process, 'chdir').mockImplementation(() => undefined)
    mockGetInput.mockImplementation((name: string) => {
      if (name === 'bucket') return 'my-bucket'
      if (name === 'dir') return '/some/dir'
      return ''
    })
    mockGetMultilineInput.mockImplementation((name: string) => {
      if (name === 'includes') return ['**/*']
      return []
    })
    mockGetBooleanInput.mockReturnValue(false)
  })

  afterEach(() => {
    mockChdir.mockRestore()
  })

  it('should fail when source directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    await run()

    expect(mockSetFailed).toHaveBeenCalledWith(
      'Source directory does not exist: /some/dir'
    )
    expect(mockChdir).not.toHaveBeenCalled()
  })

  it('should fail when source path is not a directory', async () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => false })

    await run()

    expect(mockSetFailed).toHaveBeenCalledWith(
      'Source directory does not exist: /some/dir'
    )
    expect(mockChdir).not.toHaveBeenCalled()
  })

  it('should fail when source directory is empty', async () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => true })
    mockReaddirSync.mockReturnValue([])

    await run()

    expect(mockSetFailed).toHaveBeenCalledWith(
      'Source directory is empty: /some/dir'
    )
  })

  it('should catch unexpected errors and call setFailed', async () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockReturnValue({ isDirectory: () => true })
    mockReaddirSync.mockImplementation((dirPath: string) => {
      if (dirPath === '.') return ['index.html']
      return []
    })
    mockLstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true
    })
    mockListRemoteFiles.mockRejectedValue(new Error('unexpected S3 failure'))

    await run()

    expect(mockSetFailed).toHaveBeenCalledWith('unexpected S3 failure')
  })

  it('should complete a full sync successfully', async () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockImplementation((p: string) => {
      if (p === '/some/dir') return { isDirectory: () => true }
      return { size: 100 }
    })
    mockReaddirSync.mockImplementation((dirPath: string) => {
      if (dirPath === '.') return ['index.html', 'style.css']
      return []
    })
    mockLstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true
    })
    mockGenerateETag.mockReturnValue('abc123')
    mockListRemoteFiles.mockResolvedValue({
      'index.html': { size: 100, etag: 'abc123' },
      'old.html': { size: 50, etag: 'xyz' }
    })
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === 'delete-orphaned') return true
      return false
    })

    await run()

    expect(mockSetFailed).not.toHaveBeenCalled()
    expect(mockUploadFiles).toHaveBeenCalled()
    expect(mockDeleteFiles).toHaveBeenCalledWith(['old.html'])
  })

  it('should not debug-log remote files even in debug mode', async () => {
    mockIsDebug.mockReturnValue(true)
    try {
      mockExistsSync.mockReturnValue(true)
      mockStatSync.mockImplementation((p: string) => {
        if (p === '/some/dir') return { isDirectory: () => true }
        return { size: 100 }
      })
      mockReaddirSync.mockImplementation((dirPath: string) => {
        if (dirPath === '.') return ['index.html']
        return []
      })
      mockLstatSync.mockReturnValue({
        isDirectory: () => false,
        isFile: () => true
      })
      mockGenerateETag.mockReturnValue('abc123')
      mockListRemoteFiles.mockResolvedValue({
        'index.html': { size: 100, etag: 'abc123' },
        'old.html': { size: 50, etag: 'xyz' }
      })

      await run()

      expect(mockSetFailed).not.toHaveBeenCalled()
      const debugged = mockDebug.mock.calls.map((c) => String(c[0])).join('\n')
      expect(debugged).toContain('index.html')
      expect(debugged).not.toContain('old.html')
    } finally {
      mockIsDebug.mockReturnValue(false)
    }
  })

  it('should warn about orphaned files when delete-orphaned is disabled', async () => {
    mockExistsSync.mockReturnValue(true)
    mockStatSync.mockImplementation((p: string) => {
      if (p === '/some/dir') return { isDirectory: () => true }
      return { size: 100 }
    })
    mockReaddirSync.mockImplementation((dirPath: string) => {
      if (dirPath === '.') return ['index.html']
      return []
    })
    mockLstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => true
    })
    mockGenerateETag.mockReturnValue('abc123')
    mockListRemoteFiles.mockResolvedValue({
      'index.html': { size: 100, etag: 'abc123' },
      'old.html': { size: 50, etag: 'xyz' }
    })
    mockGetBooleanInput.mockReturnValue(false)

    await run()

    expect(mockSetFailed).not.toHaveBeenCalled()
    expect(mockWarning).toHaveBeenCalledWith(
      "1 orphaned files would be deleted if 'delete-orphaned' were enabled"
    )
    expect(mockDeleteFiles).not.toHaveBeenCalled()
  })
})
