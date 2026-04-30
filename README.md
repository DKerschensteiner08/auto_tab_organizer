# Smart Tab Tidy

A Chrome (MV3) extension to organize, deduplicate, and park browser tabs.

## Features

- **AI Group Similar Tabs** — clusters tabs by semantic similarity using OpenAI embeddings.
- **Group by Domain** — one tab group per domain in the current window.
- **Sort by Domain** — alphabetically sorts ungrouped tabs by domain (pinned tabs and grouped tabs are left alone).
- **Ungroup All** — clears all tab groups in the current window.
- **Close Duplicates** — closes URL duplicates (ignoring fragments and tracking parameters).
- **Park Tabs** — saves and closes non-active tabs as a session for later restore.
- **Sessions** — restore or delete saved sessions individually from the popup.

## Setup

1. Clone or download this repository.
2. Open `chrome://extensions/`, enable Developer mode, and click **Load unpacked**.
3. Select this folder.
4. Open the extension's options page and paste your OpenAI API key (only needed for AI grouping).

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| AI Group Similar Tabs | `Ctrl/⌘ Shift S` |
| Group by Domain | `Ctrl/⌘ Shift G` |
| Park Tabs | `Ctrl/⌘ Shift P` |
| Close Duplicates | `Ctrl/⌘ Shift D` |

Customize via `chrome://extensions/shortcuts`.

## Privacy

Tab titles, URLs, and (optionally) short page snippets are sent to OpenAI's embeddings API only when AI grouping runs. Your API key and saved sessions are stored locally via `chrome.storage.local` and never leave your browser otherwise.
