# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Nothing yet

## [1.2.0] - 2026-02-28

### Fixed

- Fix `deleteFiles` not prepending S3 key prefix (orphan deletion broken with
  prefix)
- Fix upload errors being swallowed instead of propagated
- Fix `SyncFile.size` not caching for 0-byte files
- Fix `readCacheControlConfig` silently accepting lines without `=`
- Fix `deleteFiles` exceeding AWS 1000-object limit (now batches)
- Fix `deleteFiles` ignoring partial delete failures
- Fix non-Error exceptions being silently dropped in `run()`

### Changed

- Migrated to ESM (`"type": "module"`) targeting Node 24
- Replaced ncc with Rollup for bundling
- Replaced minimatch with picomatch for glob matching
- Switched ESLint to flat config
- Moved tests to `__tests__/` with Jest 30 and ESM support
- Updated all dependencies

### Added

- CI workflows for linting, dist check, and CodeQL analysis
- Release script

## [1.1.1] - 2025-09-05

- Updated dependencies

## [1.1.0] - 2024-09-15

### Added

- Multipart upload support for S3 #78

## 1.0.0 - 2024-08-20

- Initial release

[Unreleased]:
  https://github.com/osiegmar/s3-publisher-action/compare/v1.2.0...main
[1.2.0]: https://github.com/osiegmar/s3-publisher-action/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/osiegmar/s3-publisher-action/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/osiegmar/s3-publisher-action/compare/v1.0.0...v1.1.0
