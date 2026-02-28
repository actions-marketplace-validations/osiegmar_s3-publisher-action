import { jest } from '@jest/globals'

const mockDebug = jest.fn()

const mockReaddirSync = jest.fn()
const mockLstatSync = jest.fn()

jest.unstable_mockModule('@actions/core', () => ({
  debug: mockDebug
}))

jest.unstable_mockModule('fs', () => ({
  default: {
    readdirSync: mockReaddirSync,
    lstatSync: mockLstatSync
  },
  readdirSync: mockReaddirSync,
  lstatSync: mockLstatSync
}))

const { listLocalFiles, globFilter, sortByGlob } =
  await import('../src/local.js')
const { SyncFile } = await import('../src/types.js')

describe('globFilter', () => {
  it('should include files matching include glob', () => {
    const filter = globFilter(['*.html', '*.js'], [])
    expect(filter('index.html')).toBe(true)
    expect(filter('app.js')).toBe(true)
  })

  it('should exclude files not matching any include glob', () => {
    const filter = globFilter(['*.html'], [])
    expect(filter('style.css')).toBe(false)
  })

  it('should exclude files matching exclude glob even if they match include', () => {
    const filter = globFilter(['*.js'], ['vendor.js'])
    expect(filter('vendor.js')).toBe(false)
    expect(filter('app.js')).toBe(true)
  })

  it('should support dot files', () => {
    const filter = globFilter(['*'], [])
    expect(filter('.hidden')).toBe(true)
  })

  it('should support matchBase (filename-only globs match in subdirs)', () => {
    const filter = globFilter(['*.html'], [])
    expect(filter('sub/dir/page.html')).toBe(true)
  })
})

describe('listLocalFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should list files recursively', () => {
    mockReaddirSync.mockImplementation((dirPath: string) => {
      if (dirPath === '.') return ['a.txt', 'sub']
      if (dirPath === 'sub') return ['b.txt']
      return []
    })
    mockLstatSync.mockImplementation((filePath: string) => {
      if (filePath === 'a.txt')
        return { isDirectory: () => false, isFile: () => true }
      if (filePath === 'sub')
        return { isDirectory: () => true, isFile: () => false }
      if (filePath === 'sub/b.txt')
        return { isDirectory: () => false, isFile: () => true }
      return { isDirectory: () => false, isFile: () => false }
    })

    const result = listLocalFiles('.')
    expect(result).toEqual(['a.txt', 'sub/b.txt'])
  })

  it('should return empty array for empty directory', () => {
    mockReaddirSync.mockReturnValue([])
    const result = listLocalFiles('.')
    expect(result).toEqual([])
  })

  it('should skip entries that are neither files nor directories', () => {
    mockReaddirSync.mockReturnValue(['link'])
    mockLstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => false
    })
    const result = listLocalFiles('.')
    expect(result).toEqual([])
  })
})

describe('sortByGlob', () => {
  function makeSyncFile(filename: string): SyncFile {
    const sf = new SyncFile(filename)
    Object.defineProperty(sf, 'size', { get: () => 100 })
    return sf
  }

  it('should sort files by glob priority', () => {
    const files = [
      makeSyncFile('style.css'),
      makeSyncFile('index.html'),
      makeSyncFile('app.js')
    ]

    const sorted = sortByGlob(files, ['*.html', '*.js', '*.css'])

    expect(sorted[0].filename).toBe('index.html')
    expect(sorted[1].filename).toBe('app.js')
    expect(sorted[2].filename).toBe('style.css')
  })

  it('should place unmatched files after matched files', () => {
    const files = [
      makeSyncFile('data.json'),
      makeSyncFile('index.html'),
      makeSyncFile('image.png')
    ]

    const sorted = sortByGlob(files, ['*.html'])

    expect(sorted[0].filename).toBe('index.html')
    expect(sorted.slice(1).map((f) => f.filename)).toEqual(
      expect.arrayContaining(['data.json', 'image.png'])
    )
  })

  it('should return files unchanged when order is empty', () => {
    const files = [
      makeSyncFile('c.txt'),
      makeSyncFile('a.txt'),
      makeSyncFile('b.txt')
    ]

    const sorted = sortByGlob(files, [])

    expect(sorted.map((f) => f.filename)).toEqual(['c.txt', 'a.txt', 'b.txt'])
  })

  it('should skip empty strings in order', () => {
    const files = [makeSyncFile('style.css'), makeSyncFile('index.html')]

    const sorted = sortByGlob(files, ['', '*.html', ''])

    expect(sorted[0].filename).toBe('index.html')
    expect(sorted[1].filename).toBe('style.css')
  })

  it('should not mutate the original array', () => {
    const files = [makeSyncFile('b.css'), makeSyncFile('a.html')]

    const sorted = sortByGlob(files, ['*.html'])

    expect(files[0].filename).toBe('b.css')
    expect(sorted[0].filename).toBe('a.html')
  })
})
