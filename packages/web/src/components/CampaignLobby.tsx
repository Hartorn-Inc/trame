import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren, JSX } from "preact";
import { client, type ApiClient } from "../api/client.ts";
import { appSignals } from "../state/appSignals.ts";
import type { Campaign, CreatePatResponse, PatRecord } from "../types/index.ts";

export interface CampaignLobbyProps {
  children?: ComponentChildren;
  client?: ApiClient;
  inviteToken?: string;
  onOpenCampaign?: (campaignId: string) => void;
  onLogout?: () => void;
}

export function CampaignLobby(props: CampaignLobbyProps): JSX.Element {
  const activeClient = props.client || client;
  const user = appSignals.authUserSignal.value;
  const campaigns = appSignals.campaignsSignal.value;

  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState("");
  const [newCampaignSystem, setNewCampaignSystem] = useState("dnd5e");

  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [inviteCampaignId, setInviteCampaignId] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState("PLAYER");
  const [mintedInviteUrl, setMintedInviteUrl] = useState<string | null>(null);

  const [isPatModalOpen, setIsPatModalOpen] = useState(false);
  const [patList, setPatList] = useState<PatRecord[]>([]);
  const [newPatName, setNewPatName] = useState("");
  const [createdPatPlaintext, setCreatedPatPlaintext] = useState<CreatePatResponse | null>(null);

  useEffect(() => {
    const checkInvite = async () => {
      let token = props.inviteToken;
      if (!token && typeof window !== "undefined" && window.location?.search) {
        const params = new URLSearchParams(window.location.search);
        token = params.get("invite") || params.get("token") || undefined;
      }
      if (token) {
        try {
          setLoading(true);
          const res = await activeClient.redeemMagicLink(token);
          appSignals.authUserSignal.value = res.user;
          const invitedCampaign: Campaign = {
            id: res.campaignId,
            name: `Campaign ${res.campaignId.slice(0, 8)}`,
            system: "dnd5e",
            role: res.role,
            createdAt: new Date().toISOString(),
          };
          appSignals.activeCampaignSignal.value = invitedCampaign;
          props.onOpenCampaign?.(res.campaignId);
          if (typeof window !== "undefined" && window.history?.replaceState) {
            const url = new URL(window.location.href);
            url.searchParams.delete("invite");
            url.searchParams.delete("token");
            window.history.replaceState({}, "", url.toString());
          }
        } catch (err: unknown) {
          setErrorMessage(err instanceof Error ? err.message : "Failed to redeem invite");
        } finally {
          setLoading(false);
        }
      }
    };
    checkInvite();
  }, [props.inviteToken]);

  useEffect(() => {
    if (!isCreateModalOpen && !isInviteModalOpen && !isPatModalOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsCreateModalOpen(false);
        setIsInviteModalOpen(false);
        setIsPatModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCreateModalOpen, isInviteModalOpen, isPatModalOpen]);

  useEffect(() => {
    if (user && campaigns.length === 0) {
      activeClient.listCampaigns().catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : "Failed to load campaigns");
      });
    }
  }, [user]);

  const handleCreateCampaignSubmit = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const name = newCampaignName.trim();
    if (!name) {
      setErrorMessage("Campaign name cannot be empty.");
      return;
    }
    setLoading(true);
    setErrorMessage(null);
    try {
      const created = await activeClient.createCampaign({
        name,
        system: newCampaignSystem,
      });
      setIsCreateModalOpen(false);
      setNewCampaignName("");
      setStatusMessage(`Campaign "${created.name}" created successfully.`);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setLoading(false);
    }
  };

  const handleExportArchiveClick = async (campaignId: string) => {
    setLoading(true);
    setErrorMessage(null);
    try {
      await activeClient.exportArchive(campaignId);
      setStatusMessage("Campaign archive exported successfully.");
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to export archive");
    } finally {
      setLoading(false);
    }
  };

  const handleImportArchiveChange = async (e: Event) => {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const result = await activeClient.importArchive(file, false);
      await activeClient.listCampaigns();
      setStatusMessage(`Campaign "${result.name}" imported (${result.actors_restored} actors restored).`);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to import archive");
    } finally {
      setLoading(false);
      target.value = "";
    }
  };

  const handleMintInviteSubmit = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    if (!inviteCampaignId) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const res = await activeClient.createCampaignInvite(inviteCampaignId, {
        role: inviteRole,
        ttlSeconds: 7 * 24 * 3600,
      });
      setMintedInviteUrl(res.inviteUrl);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to create invite");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenPatModal = async () => {
    setIsPatModalOpen(true);
    setCreatedPatPlaintext(null);
    try {
      const pats = await activeClient.listPats();
      setPatList(pats);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to list PATs");
    }
  };

  const handleCreatePatSubmit = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    try {
      const res = await activeClient.createPat({
        name: newPatName || "Default Token",
        scopes: ["campaigns:read", "campaigns:write"],
      });
      setCreatedPatPlaintext(res);
      const pats = await activeClient.listPats();
      setPatList(pats);
      setNewPatName("");
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to create PAT");
    }
  };

  return (
    <main
      role="main"
      aria-label="Campaign Lobby"
      style={{
        minHeight: "100vh",
        backgroundColor: "#0b0f19",
        color: "#f8fafc",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "1.5rem",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid #1e293b",
          paddingBottom: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5rem", color: "#f59e0b" }}>TRAME VTT Campaign Lobby</h1>
          {user && (
            <div style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#94a3b8" }}>
              Logged in as <strong>{user.displayName}</strong> ({user.role})
              {user.isGuest && (
                <span
                  data-testid="ephemeral-badge"
                  style={{
                    marginLeft: "0.5rem",
                    padding: "0.125rem 0.375rem",
                    backgroundColor: "#334155",
                    color: "#38bdf8",
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                  }}
                >
                  Guest Session
                </span>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            type="button"
            onClick={handleOpenPatModal}
            data-testid="open-pat-modal-btn"
            style={{
              padding: "0.5rem 0.875rem",
              backgroundColor: "#1e293b",
              color: "#cbd5e1",
              border: "1px solid #334155",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Security & PATs
          </button>
          <button
            type="button"
            onClick={async () => {
              await activeClient.logout();
              props.onLogout?.();
            }}
            data-testid="logout-btn"
            style={{
              padding: "0.5rem 0.875rem",
              backgroundColor: "#334155",
              color: "#f8fafc",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Log Out
          </button>
        </div>
      </header>

      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          data-testid="status-banner"
          style={{
            backgroundColor: "#064e3b",
            color: "#6ee7b7",
            padding: "0.75rem 1rem",
            borderRadius: "4px",
            marginBottom: "1rem",
          }}
        >
          {statusMessage}
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="error-banner"
          style={{
            backgroundColor: "#450a0a",
            color: "#fca5a5",
            padding: "0.75rem 1rem",
            borderRadius: "4px",
            marginBottom: "1rem",
          }}
        >
          {errorMessage}
        </div>
      )}

      <section aria-label="Campaign management actions" style={{ marginBottom: "2rem", display: "flex", gap: "1rem" }}>
        <button
          type="button"
          onClick={() => {
            setIsCreateModalOpen(true);
            setErrorMessage(null);
          }}
          data-testid="create-campaign-btn"
          style={{
            padding: "0.625rem 1.25rem",
            backgroundColor: "#f59e0b",
            color: "#0f172a",
            fontWeight: 600,
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          Create Campaign
        </button>

        <label
          role={"button" as any}
          data-testid="import-archive-btn"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              (e.currentTarget.querySelector('input[type="file"]') as HTMLInputElement | null)?.click();
            }
          }}
          style={{
            position: "relative",
            overflow: "hidden",
            padding: "0.625rem 1.25rem",
            backgroundColor: "#1e293b",
            color: "#38bdf8",
            border: "1px solid #38bdf8",
            borderRadius: "4px",
            cursor: "pointer",
            display: "inline-block",
          }}
        >
          Import Archive (.trame)
          <input
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            aria-label="Import Archive (.trame)"
            accept=".trame,.zip"
            onChange={handleImportArchiveChange}
            data-testid="import-archive-input"
            style={{
              position: "absolute",
              width: "1px",
              height: "1px",
              padding: 0,
              margin: "-1px",
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          />
        </label>
      </section>

      <section aria-labelledby="campaigns-heading">
        <h2 id="campaigns-heading" style={{ fontSize: "1.25rem", marginBottom: "1rem", color: "#cbd5e1" }}>
          Active Campaigns
        </h2>

        {campaigns.length === 0 ? (
          <p data-testid="empty-campaigns-msg" style={{ color: "#94a3b8" }}>
            No campaigns available. Click "Create Campaign" to bootstrap your adventure.
          </p>
        ) : (
          <div
            role="list"
            data-testid="campaign-list"
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "1rem" }}
          >
            {campaigns.map((camp) => (
              <div key={camp.id} role="listitem">
                <article
                  aria-labelledby={`camp-title-${camp.id}`}
                  data-testid={`campaign-card-${camp.id}`}
                style={{
                  backgroundColor: "#131a2a",
                  border: "1px solid #1e293b",
                  borderRadius: "6px",
                  padding: "1.25rem",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <h3 id={`camp-title-${camp.id}`} style={{ margin: "0 0 0.5rem 0", fontSize: "1.125rem" }}>
                    {camp.name}
                  </h3>
                  <div style={{ fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.75rem" }}>
                    System: <span style={{ color: "#f59e0b" }}>{camp.system}</span> | Role:{" "}
                    <span style={{ color: "#38bdf8" }}>{camp.role}</span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => {
                      appSignals.activeCampaignSignal.value = camp;
                      props.onOpenCampaign?.(camp.id);
                    }}
                    data-testid={`enter-campaign-${camp.id}`}
                    style={{
                      padding: "0.375rem 0.75rem",
                      backgroundColor: "#0369a1",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                    }}
                  >
                    Enter Table
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportArchiveClick(camp.id)}
                    data-testid="export-archive-btn"
                    style={{
                      padding: "0.375rem 0.75rem",
                      backgroundColor: "#1e293b",
                      color: "#cbd5e1",
                      border: "1px solid #334155",
                      borderRadius: "4px",
                      cursor: "pointer",
                    }}
                  >
                    Export Archive
                  </button>
                  {(camp.role === "GM" || user?.role === "GM") && (
                    <button
                      type="button"
                      onClick={() => {
                        setInviteCampaignId(camp.id);
                        setIsInviteModalOpen(true);
                        setMintedInviteUrl(null);
                      }}
                      data-testid={`invite-btn-${camp.id}`}
                      style={{
                        padding: "0.375rem 0.75rem",
                        backgroundColor: "#1e293b",
                        color: "#c084fc",
                        border: "1px solid #c084fc",
                        borderRadius: "4px",
                        cursor: "pointer",
                      }}
                    >
                      Magic Link Invite
                    </button>
                  )}
                </div>
                </article>
              </div>
            ))}
          </div>
        )}
      </section>

      {isCreateModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-modal-title"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            style={{
              backgroundColor: "#131a2a",
              border: "1px solid #334155",
              borderRadius: "8px",
              padding: "1.5rem",
              maxWidth: "440px",
              width: "100%",
            }}
          >
            <h2 id="create-modal-title" style={{ margin: "0 0 1rem 0", fontSize: "1.25rem" }}>
              Create Campaign
            </h2>
            <form onSubmit={handleCreateCampaignSubmit} data-testid="create-campaign-form">
              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="new-camp-name" style={{ display: "block", marginBottom: "0.25rem" }}>
                  Campaign Name <span aria-hidden="true" style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  id="new-camp-name"
                  type="text"
                  value={newCampaignName}
                  onInput={(e) => setNewCampaignName((e.target as HTMLInputElement).value)}
                  required
                  aria-required="true"
                  data-testid="create-campaign-name-input"
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    color: "#f8fafc",
                    boxSizing: "border-box",
                  }}
                />
              </div>
              <div style={{ marginBottom: "1.5rem" }}>
                <label htmlFor="new-camp-sys" style={{ display: "block", marginBottom: "0.25rem" }}>
                  Ruleset System
                </label>
                <select
                  id="new-camp-sys"
                  value={newCampaignSystem}
                  onChange={(e) => setNewCampaignSystem((e.target as HTMLSelectElement).value)}
                  data-testid="create-campaign-system-select"
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    color: "#f8fafc",
                    boxSizing: "border-box",
                  }}
                >
                  <option value="dnd5e">D&D 5e SRD 5.1</option>
                </select>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#334155",
                    color: "#f8fafc",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  data-testid="submit-create-campaign-btn"
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#f59e0b",
                    color: "#0f172a",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isInviteModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-modal-title"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            style={{
              backgroundColor: "#131a2a",
              border: "1px solid #334155",
              borderRadius: "8px",
              padding: "1.5rem",
              maxWidth: "440px",
              width: "100%",
            }}
          >
            <h2 id="invite-modal-title" style={{ margin: "0 0 1rem 0", fontSize: "1.25rem" }}>
              Mint Magic Link Invite
            </h2>
            <form onSubmit={handleMintInviteSubmit} data-testid="mint-invite-form">
              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="invite-role-select" style={{ display: "block", marginBottom: "0.25rem" }}>
                  Target Role
                </label>
                <select
                  id="invite-role-select"
                  value={inviteRole}
                  onChange={(e) => setInviteRole((e.target as HTMLSelectElement).value)}
                  data-testid="invite-role-select"
                  style={{
                    width: "100%",
                    padding: "0.5rem",
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    color: "#f8fafc",
                  }}
                >
                  <option value="PLAYER">PLAYER</option>
                  <option value="SPECTATOR">SPECTATOR</option>
                  <option value="ASSISTANT_GM">ASSISTANT_GM</option>
                </select>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginBottom: "1rem" }}>
                <button
                  type="button"
                  onClick={() => setIsInviteModalOpen(false)}
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#334155",
                    color: "#f8fafc",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  data-testid="generate-invite-btn"
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#7e22ce",
                    color: "#ffffff",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                >
                  Generate Invite
                </button>
              </div>
            </form>
            {mintedInviteUrl && (
              <div style={{ marginTop: "1rem", padding: "0.75rem", backgroundColor: "#0f172a", borderRadius: "4px" }}>
                <label
                  htmlFor="minted-invite-url-input"
                  style={{ fontSize: "0.75rem", color: "#94a3b8", display: "block" }}
                >
                  Shareable Magic Link:
                </label>
                <input
                  id="minted-invite-url-input"
                  aria-label="Shareable Magic Link"
                  type="text"
                  readOnly
                  value={mintedInviteUrl}
                  data-testid="minted-invite-url-input"
                  style={{
                    width: "100%",
                    padding: "0.375rem",
                    backgroundColor: "#1e293b",
                    color: "#38bdf8",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    marginTop: "0.25rem",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {isPatModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pat-modal-title"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
        >
          <div
            style={{
              backgroundColor: "#131a2a",
              border: "1px solid #334155",
              borderRadius: "8px",
              padding: "1.5rem",
              maxWidth: "500px",
              width: "100%",
            }}
          >
            <h2 id="pat-modal-title" style={{ margin: "0 0 1rem 0", fontSize: "1.25rem" }}>
              Personal Access Tokens (PAT)
            </h2>
            <form onSubmit={handleCreatePatSubmit} data-testid="create-pat-form" style={{ marginBottom: "1.5rem" }}>
              <label
                htmlFor="pat-name-input"
                style={{ display: "block", fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.25rem" }}
              >
                Token Label
              </label>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  id="pat-name-input"
                  aria-label="Token Label"
                  type="text"
                  placeholder="Token Label (e.g. MCP Assistant)"
                  value={newPatName}
                  onInput={(e) => setNewPatName((e.target as HTMLInputElement).value)}
                  data-testid="pat-name-input"
                  style={{
                    flex: 1,
                    padding: "0.5rem",
                    backgroundColor: "#0f172a",
                    border: "1px solid #334155",
                    borderRadius: "4px",
                    color: "#f8fafc",
                  }}
                />
                <button
                  type="submit"
                  data-testid="create-pat-btn"
                  style={{
                    padding: "0.5rem 1rem",
                    backgroundColor: "#38bdf8",
                    color: "#0f172a",
                    fontWeight: 600,
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                >
                  Create
                </button>
              </div>
            </form>

            {createdPatPlaintext && (
              <div
                role="status"
                data-testid="pat-created-alert"
                style={{
                  backgroundColor: "#064e3b",
                  color: "#a7f3d0",
                  padding: "0.75rem",
                  borderRadius: "4px",
                  marginBottom: "1rem",
                }}
              >
                <strong>Save token now (shown once):</strong>
                <code
                  data-testid="pat-plaintext-value"
                  style={{ display: "block", wordBreak: "break-all", marginTop: "0.25rem" }}
                >
                  {createdPatPlaintext.token}
                </code>
              </div>
            )}

            <div style={{ maxHeight: "200px", overflowY: "auto", marginBottom: "1rem" }}>
              {patList.length === 0 ? (
                <p style={{ color: "#94a3b8", fontSize: "0.875rem" }}>No active access tokens.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {patList.map((pat) => (
                    <li
                      key={pat.id}
                      style={{
                        padding: "0.5rem",
                        borderBottom: "1px solid #1e293b",
                        fontSize: "0.875rem",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>{pat.name || "Token"}</span>
                      <span style={{ color: "#94a3b8" }}>Scopes: {pat.scopes.join(", ")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={() => setIsPatModalOpen(false)}
                style={{
                  padding: "0.5rem 1rem",
                  backgroundColor: "#334155",
                  color: "#f8fafc",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
