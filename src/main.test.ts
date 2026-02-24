jest.mock('@actions/core', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    getInput: jest.fn().mockReturnValue(''),
    getMultilineInput: jest.fn().mockReturnValue([]),
    getBooleanInput: jest.fn().mockReturnValue(false),
    setFailed: jest.fn()
}))

jest.mock('./s3', () => ({
    S3: jest.fn().mockImplementation(() => ({
        listRemoteFiles: jest.fn().mockResolvedValue({})
    }))
}))

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    readdirSync: jest.fn(),
    lstatSync: jest.fn(),
    statSync: jest.fn()
}))

jest.mock('s3-etag', () => ({
    generateETag: jest.fn()
}))

import * as core from '@actions/core'
import * as fs from 'fs'
import {generateETag} from 's3-etag'
import {readCacheControlConfig, getAllFiles, globFilter, globPos, isFileSizeChange, isEtagChange, isFileChange} from './main'
import {SyncFile, RemoteFile} from './types'

const mockedReaddirSync = fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>
const mockedLstatSync = fs.lstatSync as jest.MockedFunction<typeof fs.lstatSync>
const mockedStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>
const mockedGenerateETag = generateETag as jest.MockedFunction<typeof generateETag>

describe('readCacheControlConfig', () => {
    it('should parse glob=value lines', () => {
        const result = readCacheControlConfig(['*.html=max-age=3600', '*.js=no-cache'])
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
        const result = readCacheControlConfig(['no-equals-here', '*.html=max-age=3600', ''])
        expect(result).toHaveLength(1)
        expect(result[0].glob).toBe('*.html')
        expect(core.warning).toHaveBeenCalledTimes(2)
        expect(core.warning).toHaveBeenCalledWith("Invalid cache-control config (missing '='): no-equals-here")
    })
})

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

describe('globPos', () => {
    it('should return index of first matching glob', () => {
        expect(globPos('index.html', ['*.js', '*.html', '*.css'])).toBe(1)
    })

    it('should return globs.length when no glob matches', () => {
        expect(globPos('file.txt', ['*.js', '*.html'])).toBe(2)
    })

    it('should return 0 for first-position match', () => {
        expect(globPos('app.js', ['*.js', '*.html'])).toBe(0)
    })
})

describe('isFileSizeChange', () => {
    it('should return false when sizes match', () => {
        mockedStatSync.mockReturnValue({size: 100} as any)
        const syncFile = new SyncFile('file.txt')
        const remoteFile: RemoteFile = {filename: 'file.txt', size: 100, etag: '"abc"'}
        expect(isFileSizeChange(syncFile, remoteFile)).toBe(false)
    })

    it('should return true when sizes differ', () => {
        mockedStatSync.mockReturnValue({size: 200} as any)
        const syncFile = new SyncFile('file.txt')
        const remoteFile: RemoteFile = {filename: 'file.txt', size: 100, etag: '"abc"'}
        expect(isFileSizeChange(syncFile, remoteFile)).toBe(true)
    })
})

describe('isEtagChange', () => {
    it('should return false when etags match', () => {
        mockedGenerateETag.mockReturnValue('abc123')
        const syncFile = new SyncFile('file.txt')
        const remoteFile: RemoteFile = {filename: 'file.txt', size: 100, etag: '"abc123"'}
        expect(isEtagChange(syncFile, remoteFile)).toBe(false)
    })

    it('should return true when etags differ', () => {
        mockedGenerateETag.mockReturnValue('abc123')
        const syncFile = new SyncFile('file.txt')
        const remoteFile: RemoteFile = {filename: 'file.txt', size: 100, etag: '"xyz789"'}
        expect(isEtagChange(syncFile, remoteFile)).toBe(true)
    })
})

describe('isFileChange', () => {
    it('should return false when both size and etag match', () => {
        mockedStatSync.mockReturnValue({size: 100} as any)
        mockedGenerateETag.mockReturnValue('abc123')
        const syncFile = new SyncFile('file.txt')
        const remoteFile: RemoteFile = {filename: 'file.txt', size: 100, etag: '"abc123"'}
        expect(isFileChange(syncFile, remoteFile)).toBe(false)
    })

    it('should return true when size differs', () => {
        mockedStatSync.mockReturnValue({size: 200} as any)
        const syncFile = new SyncFile('file.txt')
        const remoteFile: RemoteFile = {filename: 'file.txt', size: 100, etag: '"abc123"'}
        expect(isFileChange(syncFile, remoteFile)).toBe(true)
    })

    it('should return true when etag differs', () => {
        mockedStatSync.mockReturnValue({size: 100} as any)
        mockedGenerateETag.mockReturnValue('different')
        const syncFile = new SyncFile('file.txt')
        const remoteFile: RemoteFile = {filename: 'file.txt', size: 100, etag: '"abc123"'}
        expect(isFileChange(syncFile, remoteFile)).toBe(true)
    })
})

describe('getAllFiles', () => {
    it('should list files recursively', () => {
        mockedReaddirSync.mockImplementation((dirPath: any) => {
            if (dirPath === '.') return ['a.txt', 'sub'] as any
            if (dirPath === './sub') return ['b.txt'] as any
            return [] as any
        })
        mockedLstatSync.mockImplementation((filePath: any) => {
            if (filePath === './a.txt') return {isDirectory: () => false, isFile: () => true} as any
            if (filePath === './sub') return {isDirectory: () => true, isFile: () => false} as any
            if (filePath === './sub/b.txt') return {isDirectory: () => false, isFile: () => true} as any
            return {isDirectory: () => false, isFile: () => false} as any
        })

        const result = getAllFiles('.')
        expect(result).toEqual(['a.txt', 'sub/b.txt'])
    })

    it('should return empty array for empty directory', () => {
        mockedReaddirSync.mockReturnValue([] as any)
        const result = getAllFiles('.')
        expect(result).toEqual([])
    })

    it('should skip entries that are neither files nor directories', () => {
        mockedReaddirSync.mockReturnValue(['link'] as any)
        mockedLstatSync.mockReturnValue({isDirectory: () => false, isFile: () => false} as any)
        const result = getAllFiles('.')
        expect(result).toEqual([])
    })
})
