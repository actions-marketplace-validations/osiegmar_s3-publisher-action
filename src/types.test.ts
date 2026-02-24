jest.mock('fs', () => ({
    statSync: jest.fn()
}))

jest.mock('s3-etag', () => ({
    generateETag: jest.fn()
}))

import fs from 'fs'
import {generateETag} from 's3-etag'
import {SyncFile, CacheControl, PART_SIZE} from './types'

const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>
const mockedGenerateETag = generateETag as jest.MockedFunction<typeof generateETag>

describe('PART_SIZE', () => {
    it('should be 16 MB', () => {
        expect(PART_SIZE).toBe(16 * 1024 * 1024)
    })
})

describe('CacheControl', () => {
    it('should store glob and headerValue', () => {
        const cc = new CacheControl('*.html', 'max-age=3600')
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
        mockedStatSync.mockReturnValue({size: 42} as any)

        const sf = new SyncFile('file.txt')
        const size = sf.size

        expect(size).toBe(42)
        expect(mockedStatSync).toHaveBeenCalledWith('file.txt')
    })

    it('should cache size after first access', () => {
        mockedStatSync.mockReturnValue({size: 42} as any)

        const sf = new SyncFile('file.txt')
        sf.size
        sf.size

        expect(mockedStatSync).toHaveBeenCalledTimes(1)
    })

    it('should cache size of 0 for empty files', () => {
        mockedStatSync.mockReturnValue({size: 0} as any)

        const sf = new SyncFile('empty.txt')
        expect(sf.size).toBe(0)
        expect(sf.size).toBe(0)

        expect(mockedStatSync).toHaveBeenCalledTimes(1)
    })

    it('should lazy-load checksum from generateETag', () => {
        mockedGenerateETag.mockReturnValue('abc123')

        const sf = new SyncFile('file.txt')
        const checksum = sf.checksum

        expect(checksum).toBe('abc123')
        expect(mockedGenerateETag).toHaveBeenCalledWith('file.txt', PART_SIZE)
    })

    it('should cache checksum after first access', () => {
        mockedGenerateETag.mockReturnValue('abc123')

        const sf = new SyncFile('file.txt')
        sf.checksum
        sf.checksum

        expect(mockedGenerateETag).toHaveBeenCalledTimes(1)
    })
})
