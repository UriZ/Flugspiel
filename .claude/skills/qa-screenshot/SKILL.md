---
name: qa-screenshot
description: Take screenshots of the live web app for QA testing. Navigates pages, interacts with forms, captures screenshots, and collects console errors.
user-invocable: true
argument-hint: "[--url URL] [--pages /,/create,/result] [--viewport WxH] [--click SELECTOR] [--type SELECTOR=TEXT] [--upload SELECTOR=FILE] [--wait SECS] [--no-interact]"
allowed-tools: Bash, Read
---

# QA Screenshot Skill

Take screenshots of the live web app using Puppeteer.

## Prerequisites

Puppeteer must be installed in the project:
```bash
cd /Users/urizonens/dev/Flugspiel && npm install -D puppeteer
```

## Usage

```bash
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js {{ options }}
```

If no options provided, screenshots all pages at the default URL (http://localhost:8000).

## After Running

1. Script prints screenshot paths to stdout — one per line
2. Read each screenshot with the Read tool to visually inspect
3. Console errors listed at the end if any

## Common Scenarios

```bash
# Screenshot all pages
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js

# Specific app URL
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js --url http://localhost:3000

# Specific pages only
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js --pages /,/create

# Mobile viewport
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js --viewport 390x844

# Click a button and screenshot
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js --pages /create --click "button"

# Upload a file
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js --pages /create --upload "input[type=file]=/tmp/test.jpg"

# Wait longer for async content
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js --wait 5

# Non-interactive — just screenshot pages
node .claude/skills/qa-screenshot/scripts/qa-screenshot.js --no-interact
```

## Notes

- App must be running on localhost
- Default viewport is 1440x900 (desktop)
- Screenshots saved to `/tmp/qa-screenshots/` (cleaned each run)
- Use `--viewport 390x844` for iPhone-like mobile testing
