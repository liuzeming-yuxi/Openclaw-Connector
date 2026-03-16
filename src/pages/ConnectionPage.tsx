import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/useConfigStore";
import { setActiveProfileId } from "../store/useProfileStore";
import { ProfileSidebar } from "../components/ProfileSidebar";
import { ProfileDetail } from "../components/ProfileDetail";
import { NewProfileForm } from "../components/NewProfileForm";

export function ConnectionPage() {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const activeProfile = config.profiles.find(
    (p) => p.id === config.activeProfileId,
  ) ?? null;

  const [mode, setMode] = useState<"view" | "new">("view");
  const [connectedProfileId, setConnectedProfileId] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-[280px_1fr] gap-0 border border-border rounded-xl overflow-hidden bg-card min-h-[600px]">
      <div className="border-r border-border bg-muted/30">
        <ProfileSidebar
          onNewProfile={() => setMode("new")}
          connectedProfileId={connectedProfileId}
        />
      </div>
      <div className="overflow-y-auto">
        {mode === "new" ? (
          <NewProfileForm
            onCreated={(id) => {
              setActiveProfileId(id);
              setMode("view");
            }}
            onCancel={() => setMode("view")}
          />
        ) : activeProfile ? (
          <ProfileDetail
            profile={activeProfile}
            onConnected={(id) => setConnectedProfileId(id)}
            onDisconnected={() => setConnectedProfileId(null)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            {t("profile.select_hint")}
          </div>
        )}
      </div>
    </div>
  );
}
