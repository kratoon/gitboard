# ADR-0013: Cross-platform support (macOS, Linux, Windows)

- **Status:** Accepted (2026-11-14)
- **Date:** 2026-11-14
- **Related:** ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0007, ADR-0008

## Context

Windows is supported in the MVP, in addition to macOS and Linux. The earlier plan treated Windows as a
non-goal, so several decisions need explicit cross-platform rules.

## Decision

Supported platforms: macOS, Linux and Windows 10/11, on Node >= 20. CI runs the full test suite on all three
(GitHub Actions `ubuntu-latest`, `macos-latest`, `windows-latest`). A feature is not done until it passes on
all three.

**Paths and filesystem (all in core, ADR-0012)**

- Use `node:path` and `node:url` helpers everywhere. No string concatenation of paths, and no assumption of
  `/`. Paths stored in committed files (`config.json`) are never absolute, and any relative path in them uses
  `/`.
- The path jail (ADR-0005) compares `realpath` results using platform rules: case-insensitive on Windows and
  default macOS volumes, with drive letters and UNC paths normalised. It rejects reparse points and symlinks
  that resolve outside the repo.
- Atomic writes use a temp file in the same directory plus `rename`. On Windows `rename` can fail with
  `EPERM`/`EBUSY` when an antivirus scanner or the file watcher holds the file, so writes retry with short
  backoff (a few attempts) before failing with a clear error.
- Exclusive creation (`wx`) behaves the same on all three platforms. IDs are 12 hex characters, so reserved
  Windows filenames and path-length limits are not a concern.
- File watching uses `chokidar`, which handles Windows. The echo-suppression logic from ADR-0004 compares
  content hashes, not paths or timestamps.

**Line endings**

- Reading and writing preserve each file's existing line endings (LF or CRLF), and never rewrite endings in
  untouched content. New issues use LF.
- `gitboard init` writes `.gitboard/.gitattributes` containing `* text eol=lf`. It is scoped inside
  `.gitboard/`, touches no other repository file, and stops `core.autocrlf` from converting issue files and
  producing noisy diffs or hash mismatches.
- Hashes for conflict detection (ADR-0004) are computed over the bytes on disk.

**Git and processes**

- `git` is run with `execFile` and no shell (ADR-0005), which also avoids `cmd.exe` quoting problems. The
  executable is resolved from `PATH`. A missing `git` or `ssh` produces a clear error. Windows 10 and later
  ship OpenSSH.
- URL checks (ADR-0005) treat `C:\...` as a local path and not as an scp-style `host:path` URL.

**User-level directories (ADR-0008)**

| | macOS / Linux | Windows |
|---|---|---|
| Config (registry, defaults) | `$XDG_CONFIG_HOME/gitboard` or `~/.config/gitboard` | `%APPDATA%\gitboard` |
| Managed clones | `~/.gitboard/repos/` | `%LOCALAPPDATA%\gitboard\repos\` |

Locations are resolved by one function in core and can be overridden by `GITBOARD_HOME` (also used by tests).

**Skills (ADR-0007)**

- Project installs default to copies, not symlinks. Global installs link where possible (symlink on POSIX,
  directory junction on Windows) and fall back to copies.

**CLI**

- npm creates the `gitboard.cmd` and PowerShell shims for the `bin` entry. Output avoids ANSI colour and
  interactive prompts when stdout is not a TTY, and `--json` output is plain UTF-8 without a BOM.
- Shell examples in the README and skill show both POSIX and PowerShell where they differ.

## Alternatives considered

- **Windows via WSL only:** excludes users with repos on the Windows filesystem and does not help agents that
  run natively on Windows.
- **Best-effort Windows without CI:** regressions would go unnoticed.

## Consequences

- CI time and cost increase, and some tests need platform-specific expectations (paths, endings).
- A few more code paths in core (write retries, path comparison, line-ending preservation), all covered by
  tests that run on every OS.
- The `.gitattributes` file inside `.gitboard/` is one more committed file, but it contains no machine-specific
  data.
