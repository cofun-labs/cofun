# UC-PANEL-001: Open the side panel on Notion

**Actor:** Notion user with the extension installed
**Goal:** Open the AI side panel next to a Notion page.

## Rules

- R1: The side panel is available only on Notion tabs (`www.notion.so`, `notion.so`, `app.notion.com`).
- R2: Clicking the toolbar icon opens the side panel.
- R3: The panel is off by default, including on tabs that were already open when the extension started.

## Scenarios

### UC-PANEL-001-S01: Toolbar icon opens the side panel on a Notion tab

- Priority: P0 · Strategy: ai-e2e · Status: ❌
- **Given** a Notion page is open in the active tab
- **When** the user clicks the extension's toolbar icon
- **Then** the side panel opens next to the page

### UC-PANEL-001-S02: Side panel is unavailable on other sites

- Priority: P1 · Strategy: ai-e2e · Status: ✅
- **Given** a non-Notion page is open in the active tab
- **When** the user clicks the extension's toolbar icon
- **Then** no side panel opens for that tab

### UC-PANEL-001-S03: Tabs open before the extension started get the right state

- Priority: P1 · Strategy: ai-e2e · Status: ✅
- **Given** a Notion tab and a non-Notion tab are open before the extension is loaded
- **When** the extension starts
- **Then** the panel is enabled on the Notion tab and disabled on the other tab
