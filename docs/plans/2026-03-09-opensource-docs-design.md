# Open-Source Documentation Design

## Goal

Make OpenClaw Connector ready for open-source release with bilingual docs (EN + zh-CN), MIT license, and community files.

## File Structure

```
openclaw-connector/
├── README.md                    # English (GitHub default)
├── README.zh-CN.md              # Chinese
├── LICENSE                      # MIT License
├── CONTRIBUTING.md              # English
├── CONTRIBUTING.zh-CN.md        # Chinese
├── docs/
│   ├── ops-runbook.md           # English (keep)
│   ├── ops-runbook.zh-CN.md     # Chinese (new)
│   ├── troubleshooting.md       # English (keep)
│   └── troubleshooting.zh-CN.md # Chinese (new)
└── .github/
    └── ISSUE_TEMPLATE/
        └── bug_report.md
```

## README Structure

Both READMEs have identical structure:

1. Language switch link at top
2. Project title + one-line description
3. Feature highlights (bullet list)
4. Quick Start (prerequisites, install, run)
5. Tech Stack (Tauri 2 + React 19 + Rust)
6. Project structure (simplified tree)
7. Development guide (dev/test/build commands)
8. Contributing link
9. License

## CONTRIBUTING Content

- How to report bugs / request features
- Dev environment setup
- PR submission guidelines
- Code style conventions

## Excluded (YAGNI)

- CHANGELOG (no releases yet)
- CODE_OF_CONDUCT (small project)
- Complex CI/CD workflows
- Multiple issue templates
