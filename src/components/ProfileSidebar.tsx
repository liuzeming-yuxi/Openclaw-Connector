import { useTranslation } from "react-i18next";
import { useConfigStore } from "../store/useConfigStore";
import { removeProfile, setActiveProfileId } from "../store/useProfileStore";
import { Button } from "./ui/button";
import { Plus, Trash2 } from "lucide-react";
import type { ConnectionProfile } from "../types/config";

type Props = {
  onNewProfile: () => void;
  connectedProfileId: string | null;
};

export function ProfileSidebar({ onNewProfile, connectedProfileId }: Props) {
  const { t } = useTranslation();
  const config = useConfigStore((s) => s.config);
  const profiles = config.profiles;
  const activeId = config.activeProfileId;

  const handleSelect = (id: string) => {
    setActiveProfileId(id);
  };

  const handleDelete = (e: React.MouseEvent, profile: ConnectionProfile) => {
    e.stopPropagation();
    if (profiles.length <= 1) return;
    if (!confirm(t("profile.confirm_delete", { name: profile.name }))) return;
    removeProfile(profile.id);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">
          {t("profile.sidebar_title")}
        </h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNewProfile}>
          <Plus className="w-4 h-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {profiles.map((profile) => {
          const isActive = profile.id === activeId;
          const isConnected = profile.id === connectedProfileId;
          return (
            <button
              key={profile.id}
              onClick={() => handleSelect(profile.id)}
              className={`w-full text-left rounded-lg p-3 transition-colors cursor-pointer border ${
                isActive
                  ? "bg-accent border-primary/30"
                  : "bg-background border-transparent hover:bg-accent/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isConnected ? "bg-green-500" : "bg-muted-foreground/30"
                  }`}
                />
                <span className="font-medium text-sm text-foreground truncate">
                  {profile.name || profile.server.host || "Unnamed"}
                </span>
                {profiles.length > 1 && (
                  <span
                    onClick={(e) => handleDelete(e, profile)}
                    className="ml-auto hover:text-destructive p-1 rounded opacity-0 hover:opacity-100 transition-opacity"
                    style={{ opacity: isActive ? 0.4 : 0 }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate pl-4">
                {profile.server.user && profile.server.host
                  ? `${profile.server.user}@${profile.server.host}`
                  : profile.server.host || t("profile.select_hint")}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
