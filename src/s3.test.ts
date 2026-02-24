const mockSend = jest.fn()

jest.mock('@actions/core', () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
}))

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({send: mockSend})),
    ListObjectsV2Command: jest.fn().mockImplementation((params: any) => ({input: params})),
    DeleteObjectsCommand: jest.fn().mockImplementation((params: any) => ({input: params}))
}))

jest.mock('@aws-sdk/lib-storage', () => ({
    Upload: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        done: jest.fn().mockResolvedValue({})
    }))
}))

jest.mock('fs', () => ({
    createReadStream: jest.fn()
}))

import {DeleteObjectsCommand} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'
import {S3} from './s3'
import {CacheControl, SyncFile} from './types'

const MockDeleteCmd = DeleteObjectsCommand as unknown as jest.Mock
const MockUpload = Upload as unknown as jest.Mock

describe('S3', () => {
    describe('listRemoteFiles', () => {
        it('should list files and strip prefix', async () => {
            mockSend.mockResolvedValueOnce({
                $metadata: {httpStatusCode: 200},
                IsTruncated: false,
                Contents: [
                    {Key: 'prefix/file1.html', Size: 100, ETag: '"abc"'},
                    {Key: 'prefix/file2.js', Size: 200, ETag: '"def"'}
                ]
            })

            const s3 = new S3('my-bucket', 'prefix/', [], false)
            const files = await s3.listRemoteFiles()

            expect(files['file1.html']).toEqual({filename: 'file1.html', size: 100, etag: '"abc"'})
            expect(files['file2.js']).toEqual({filename: 'file2.js', size: 200, etag: '"def"'})
        })

        it('should handle pagination', async () => {
            mockSend
                .mockResolvedValueOnce({
                    $metadata: {httpStatusCode: 200},
                    IsTruncated: true,
                    NextContinuationToken: 'token1',
                    Contents: [{Key: 'file1.html', Size: 100, ETag: '"abc"'}]
                })
                .mockResolvedValueOnce({
                    $metadata: {httpStatusCode: 200},
                    IsTruncated: false,
                    Contents: [{Key: 'file2.html', Size: 200, ETag: '"def"'}]
                })

            const s3 = new S3('my-bucket', '', [], false)
            const files = await s3.listRemoteFiles()

            expect(Object.keys(files)).toHaveLength(2)
            expect(mockSend).toHaveBeenCalledTimes(2)
        })

        it('should throw on non-200 status', async () => {
            mockSend.mockResolvedValueOnce({
                $metadata: {httpStatusCode: 403},
                Contents: []
            })

            const s3 = new S3('my-bucket', '', [], false)
            await expect(s3.listRemoteFiles()).rejects.toThrow('Failed to list objects')
        })

        it('should handle empty Contents', async () => {
            mockSend.mockResolvedValueOnce({
                $metadata: {httpStatusCode: 200},
                IsTruncated: false,
                Contents: undefined
            })

            const s3 = new S3('my-bucket', '', [], false)
            const files = await s3.listRemoteFiles()
            expect(Object.keys(files)).toHaveLength(0)
        })
    })

    describe('resolveCacheControl', () => {
        it('should return matching cache-control header', () => {
            const cc = [new CacheControl('*.html', 'max-age=3600'), new CacheControl('*.js', 'no-cache')]
            const s3 = new S3('my-bucket', '', cc, false)
            expect(s3.resolveCacheControl('index.html')).toBe('max-age=3600')
            expect(s3.resolveCacheControl('app.js')).toBe('no-cache')
        })

        it('should return first matching glob', () => {
            const cc = [new CacheControl('*', 'max-age=60'), new CacheControl('*.html', 'max-age=3600')]
            const s3 = new S3('my-bucket', '', cc, false)
            expect(s3.resolveCacheControl('index.html')).toBe('max-age=60')
        })

        it('should return undefined when no glob matches', () => {
            const cc = [new CacheControl('*.html', 'max-age=3600')]
            const s3 = new S3('my-bucket', '', cc, false)
            expect(s3.resolveCacheControl('style.css')).toBeUndefined()
        })
    })

    describe('uploadFiles', () => {
        it('should upload each file', async () => {
            const sf = new SyncFile('file.html')
            Object.defineProperty(sf, 'size', {get: () => 100})

            const s3 = new S3('my-bucket', 'prefix/', [], false)
            await s3.uploadFiles([sf])

            expect(MockUpload).toHaveBeenCalledTimes(1)
            const params = MockUpload.mock.calls[0][0].params
            expect(params.Bucket).toBe('my-bucket')
            expect(params.Key).toBe('prefix/file.html')
            expect(params.ContentType).toBe('text/html')
        })

        it('should not upload in dry-run mode', async () => {
            const sf = new SyncFile('file.html')
            Object.defineProperty(sf, 'size', {get: () => 100})

            const s3 = new S3('my-bucket', '', [], true)
            await s3.uploadFiles([sf])

            expect(MockUpload).not.toHaveBeenCalled()
        })

        it('should propagate upload errors', async () => {
            MockUpload.mockImplementationOnce(() => ({
                on: jest.fn(),
                done: jest.fn().mockRejectedValue(new Error('network failure'))
            }))

            const sf = new SyncFile('file.html')
            Object.defineProperty(sf, 'size', {get: () => 100})

            const s3 = new S3('my-bucket', '', [], false)
            await expect(s3.uploadFiles([sf])).rejects.toThrow('network failure')
        })
    })

    describe('deleteFiles', () => {
        it('should send DeleteObjectsCommand', async () => {
            mockSend.mockResolvedValueOnce({Deleted: [{Key: 'file1.html'}]})

            const s3 = new S3('my-bucket', '', [], false)
            await s3.deleteFiles(['file1.html'])

            expect(mockSend).toHaveBeenCalledTimes(1)
        })

        it('should prepend prefix to delete keys', async () => {
            mockSend.mockResolvedValueOnce({Deleted: [{Key: 'site/file1.html'}]})

            const s3 = new S3('my-bucket', 'site/', [], false)
            await s3.deleteFiles(['file1.html'])

            expect(MockDeleteCmd).toHaveBeenCalledWith({
                Bucket: 'my-bucket',
                Delete: {
                    Objects: [{Key: 'site/file1.html'}]
                }
            })
        })

        it('should not delete in dry-run mode', async () => {
            const s3 = new S3('my-bucket', '', [], true)
            await s3.deleteFiles(['file1.html'])

            expect(mockSend).not.toHaveBeenCalled()
        })

        it('should batch deletes in groups of 1000', async () => {
            const files = Array.from({length: 2500}, (_, i) => `file${i}.html`)
            mockSend
                .mockResolvedValueOnce({Deleted: []})
                .mockResolvedValueOnce({Deleted: []})
                .mockResolvedValueOnce({Deleted: []})

            const s3 = new S3('my-bucket', '', [], false)
            await s3.deleteFiles(files)

            expect(mockSend).toHaveBeenCalledTimes(3)
        })

        it('should throw on partial delete failures', async () => {
            mockSend.mockResolvedValueOnce({
                Deleted: [{Key: 'file1.html'}],
                Errors: [{Key: 'file2.html', Code: 'AccessDenied', Message: 'Access Denied'}]
            })

            const s3 = new S3('my-bucket', '', [], false)
            await expect(s3.deleteFiles(['file1.html', 'file2.html'])).rejects.toThrow(
                'Failed to delete objects: file2.html'
            )
        })
    })
})
