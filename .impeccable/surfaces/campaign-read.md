# Surface Contract: Campaign Lobby, Wiki Notes & Compendium (`Read` Mode)

- **Primary Mode**: `Read` (with `Operate` actions for campaign launch, `.trame` Archive import/export, and handout reveal)
- **Target Components**: `AuthScreen`, `CampaignLobby`, `CampaignWorkspace` (`Actors`, `Journal`, `Compendium`, `Settings` tabs), `PartyJournal`, `NotesMarkdownPane`.
- **Surface Rules**:
  1. **Daylight & Dark Theme Parity**: Must pass WCAG 2.2 AA (`>= 4.5:1` text, `>= 3.0:1` UI borders/focus) in both `[data-theme="dark"]` (`#0F1A25`) and `[data-theme="light"]` (`#F4F7F9`).
  2. **Readable Measure & Hierarchy**: Long-form Markdown notes (`CRDTDocument`), handout modals (`:::handout`), and GM secret blocks (`:::dm`) constrain line width to `60ch–72ch` using `IBM Plex Sans` (`16px`, line-height `1.5`) and `Space Grotesk` headings without uppercase eyebrow kickers.
  3. **Flat Structural Framing**: Cards and list rows in `CampaignLobby` and `Compendium` use `1px solid var(--atlas-border)` on `--atlas-surface` (`border-radius: 8px`) with zero nested bordered cards and zero decorative glow shadows.
  4. **Cartographic Empty States**: Empty campaign lists, empty actor rosters, and empty journals render inline theme-adaptive SVGs from `AtlasEmptyStates.tsx` (zero `<text>` nodes inside SVG) paired with semantic HTML headings and primary action CTAs.
