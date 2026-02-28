import { jest } from '@jest/globals'
import type { CacheControl } from '../src/types.js'

const mockStatSync = jest.fn()
const mockGenerateETag = jest.fn()

jest.unstable_mockModule('fs', () => ({
  default: { statSync: mockStatSync },
  statSync: mockStatSync
}))

jest.unstable_mockModule('s3-etag', () => ({
  generateETag: mockGenerateETag
}))

const { SyncFile, PART_SIZE, formatElapsed, formatSize } =
  await import('../src/types.js')

describe('PART_SIZE', () => {
  it('should be 16 MB', () => {
    expect(PART_SIZE).toBe(16 * 1024 * 1024)
  })
})

describe('formatElapsed', () => {
  it('should format sub-second durations as milliseconds', () => {
    expect(formatElapsed(0)).toBe('0ms')
    expect(formatElapsed(42)).toBe('42ms')
    expect(formatElapsed(999)).toBe('999ms')
  })

  it('should format durations >= 1s with one decimal', () => {
    expect(formatElapsed(1000)).toBe('1.0s')
    expect(formatElapsed(1500)).toBe('1.5s')
    expect(formatElapsed(12345)).toBe('12.3s')
  })
})

describe('formatSize', () => {
  it('should format bytes', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
  })

  it('should format kibibytes', () => {
    expect(formatSize(1024)).toBe('1.0 KiB')
    expect(formatSize(1536)).toBe('1.5 KiB')
  })

  it('should format mebibytes', () => {
    expect(formatSize(1048576)).toBe('1.0 MiB')
  })

  it('should format gibibytes', () => {
    expect(formatSize(1073741824)).toBe('1.0 GiB')
  })
})

describe('CacheControl', () => {
  it('should store glob and headerValue', () => {
    const cc: CacheControl = { glob: '*.html', headerValue: 'max-age=3600' }
    expect(cc.glob).toBe('*.html')
    expect(cc.headerValue).toBe('max-age=3600')
  })
})

describe('SyncFile', () => {
  it('should return filename', () => {
    const sf = new SyncFile('dir/file.txt')
    expect(sf.filename).toBe('dir/file.txt')
  })

  it('should lazy-load size from fs.statSync', () => {
    mockStatSync.mockReturnValue({ size: 42 })

    const sf = new SyncFile('file.txt')
    const size = sf.size

    expect(size).toBe(42)
    expect(mockStatSync).toHaveBeenCalledWith('file.txt')
  })

  it('should cache size after first access', () => {
    mockStatSync.mockReturnValue({ size: 42 })

    const sf = new SyncFile('file.txt')
    void sf.size
    void sf.size

    expect(mockStatSync).toHaveBeenCalledTimes(1)
  })

  it('should cache size of 0 for empty files', () => {
    mockStatSync.mockReturnValue({ size: 0 })

    const sf = new SyncFile('empty.txt')
    expect(sf.size).toBe(0)
    expect(sf.size).toBe(0)

    expect(mockStatSync).toHaveBeenCalledTimes(1)
  })

  it('should lazy-load checksum from generateETag', () => {
    mockGenerateETag.mockReturnValue('abc123')

    const sf = new SyncFile('file.txt')
    const checksum = sf.checksum

    expect(checksum).toBe('abc123')
    expect(mockGenerateETag).toHaveBeenCalledWith('file.txt', PART_SIZE)
  })

  it('should cache checksum after first access', () => {
    mockGenerateETag.mockReturnValue('abc123')

    const sf = new SyncFile('file.txt')
    void sf.checksum
    void sf.checksum

    expect(mockGenerateETag).toHaveBeenCalledTimes(1)
  })
})
