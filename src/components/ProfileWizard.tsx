import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { useConfigStore } from "../store/useConfigStore";
import {
  addProfile,
  createDefaultProfile,
  removeProfile,
  updateProfile,
} from "../store/useProfileStore";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Key,
  ChevronDown,
  Plus,
  Copy,
  Check,
} from "lucide-react";

type Props = {
  onCreated: (profileId: string) => void;
  onCancel: () => void;
};

type SshStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "success" }
  | { state: "error"; message: string };

type ConfigStatus =
  | { state: "idle" }
  | { state: "reading" }
  | { state: "success" }
  | { state: "error" };

type WsStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "success" }
  | { state: "error"; message: string };

const STEPS = [1, 2, 3] as const;

export function ProfileWizard({ onCreated, onCancel }: Props) {
  const { t } = useTranslation();

  // --- Step state ---
  const [step, setStep] = useState(1);

  // --- Step 1 fields ---
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [sshKeys, setSshKeys] = useState<string[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [sshStatus, setSshStatus] = useState<SshStatus>({ state: "idle" });
  const [creatingKey, setCreatingKey] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [copied, setCopied] = useState(false);

  // --- Step 2 fields ---
  const [token, setToken] = useState("");
  const [port, setPort] = useState(18789);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>({
    state: "idle",
  });
  const [wsStatus, setWsStatus] = useState<WsStatus>({ state: "idle" });

  // --- Step 3 fields ---
  const [profileName, setProfileName] = useState("");

  // --- Temp profile tracking (for cleanup) ---
  const tempProfileIdRef = useRef<string | null>(null);

  // Scan SSH keys on mount
  useEffect(() => {
    invoke<string[]>("list_ssh_keys")
      .then((keys) => {
        setSshKeys(keys);
        if (keys.length > 0 && !keyPath) {
          setKeyPath(keys[0]);
        }
      })
      .catch(() => {})
      .finally(() => setKeysLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset SSH status when any Step 1 field changes
  useEffect(() => {
    setSshStatus({ state: "idle" });
    setCopied(false);
  }, [host, user, keyPath]);

  // Load public key when key path changes
  useEffect(() => {
    if (!keyPath) { setPublicKey(""); return; }
    invoke<string>("read_ssh_public_key", { keyPath })
      .then(setPublicKey)
      .catch(() => setPublicKey(""));
  }, [keyPath]);

  // Auto-read remote config when entering Step 2
  useEffect(() => {
    if (step !== 2) return;
    if (configStatus.state !== "idle") return;

    let cancelled = false;
    setConfigStatus({ state: "reading" });

    invoke<{ token: string; port: number }>("read_remote_gateway_config", {
      host,
      user,
      keyPath,
    })
      .then((result) => {
        if (cancelled) return;
        setToken(result.token);
        setPort(result.port);
        setConfigStatus({ state: "success" });
      })
      .catch(() => {
        if (cancelled) return;
        setConfigStatus({ state: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set default profile name when entering Step 3
  useEffect(() => {
    if (step === 3 && !profileName) {
      setProfileName(`${user}@${host}`);
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Cleanup helper ---
  const cleanupTempProfile = useCallback(async () => {
    const id = tempProfileIdRef.current;
    if (!id) return;
    try {
      await invoke("disconnect");
    } catch {
      /* best-effort */
    }
    removeProfile(id);
    tempProfileIdRef.current = null;
  }, []);

  // --- Flush config to disk (bypasses debounce) ---
  const flushConfig = async () => {
    const cfg = useConfigStore.getState().config;
    await invoke("save_app_config", { cfg });
  };

  // --- Handlers ---
  const createKey = async () => {
    setCreatingKey(true);
    try {
      const result = await invoke<{ privateKeyPath: string; publicKey: string }>("generate_ssh_key");
      // Refresh key list
      const keys = await invoke<string[]>("list_ssh_keys");
      setSshKeys(keys);
      setKeyPath(result.privateKeyPath);
      setPublicKey(result.publicKey);
    } catch (err) {
      console.error("Failed to create SSH key:", err);
    } finally {
      setCreatingKey(false);
    }
  };

  const copyPublicKey = async () => {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const testSsh = async () => {
    setSshStatus({ state: "testing" });
    try {
      await invoke("test_ssh_connection", { host, user, keyPath });
      setSshStatus({ state: "success" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSshStatus({ state: "error", message: msg });
    }
  };

  const testGateway = async () => {
    // Clean up any previous temp profile first
    await cleanupTempProfile();

    setWsStatus({ state: "testing" });
    try {
      // Create a real profile so connect() can load it from config
      const profile = createDefaultProfile();
      profile.name = `${user}@${host}`;
      profile.server.host = host;
      profile.server.user = user;
      profile.server.keyPath = keyPath;
      profile.server.localPort = port;
      profile.server.remotePort = port;
      profile.gatewayToken = token;
      addProfile(profile);
      tempProfileIdRef.current = profile.id;

      // Flush to disk immediately so Rust connect() can find the profile
      await flushConfig();

      await invoke("connect", { profileId: profile.id });
      setWsStatus({ state: "success" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setWsStatus({ state: "error", message: msg });
      // On failure, disconnect and remove temp profile
      await cleanupTempProfile();
    }
  };

  const handleCancel = async () => {
    await cleanupTempProfile();
    onCancel();
  };

  const handleSave = () => {
    const id = tempProfileIdRef.current;
    if (!id) return;
    updateProfile(id, { name: profileName.trim() || `${user}@${host}` });
    // Profile already exists and is connected -- hand off to parent
    tempProfileIdRef.current = null; // no cleanup needed on unmount
    onCreated(id);
  };

  const goBack = () => {
    if (step === 2) {
      // Reset step-2 state so auto-read fires again next time
      setConfigStatus({ state: "idle" });
      setWsStatus({ state: "idle" });
    }
    setStep((s) => Math.max(1, s - 1));
  };

  const goNext = () => {
    setStep((s) => Math.min(3, s + 1));
  };

  // --- Step indicator ---
  const stepLabels = [
    t("wizard.step1_title"),
    t("wizard.step2_title"),
    t("wizard.step3_title"),
  ];

  return (
    <div className="p-6 flex flex-col h-full min-h-[480px]">
      {/* Step indicator */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-colors ${
                  step === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : step > s
                      ? "bg-primary/20 text-primary border-primary/40"
                      : "bg-muted text-muted-foreground border-border"
                }`}
              >
                {step > s ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  s
                )}
              </div>
              <span
                className={`text-sm font-medium hidden sm:inline ${
                  step === s
                    ? "text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {stepLabels[i]}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={`w-12 h-0.5 mx-1 ${
                  step > s ? "bg-primary/40" : "bg-border"
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {/* Step content */}
      <div className="flex-1">
        {/* Step 1: SSH Connection */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              {t("wizard.step1_title")}
            </h2>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t("connection.host")}
                </label>
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.1.100"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t("connection.user")}
                </label>
                <Input
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="root"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            </div>

            {/* SSH Key selector */}
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                {t("wizard.select_key")}
              </label>
              {keysLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse py-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t("wizard.scanning_keys")}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {sshKeys.length > 0 ? (
                    <div className="relative flex-1">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                      <select
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        className="w-full h-10 pl-9 pr-9 rounded-md border border-input bg-background text-sm text-foreground appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      >
                        {sshKeys.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center gap-2 text-sm text-muted-foreground py-2">
                      <AlertCircle className="w-4 h-4" />
                      {t("wizard.no_keys_found")}
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={createKey}
                    disabled={creatingKey}
                  >
                    {creatingKey ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 mr-1" />
                    )}
                    {creatingKey ? t("wizard.creating_key") : t("wizard.create_key")}
                  </Button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button
                onClick={testSsh}
                disabled={
                  !host.trim() ||
                  !user.trim() ||
                  !keyPath ||
                  sshStatus.state === "testing"
                }
                variant="secondary"
              >
                {sshStatus.state === "testing" && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                {sshStatus.state === "testing"
                  ? t("wizard.testing")
                  : t("wizard.test_ssh")}
              </Button>

              {sshStatus.state === "success" && (
                <div className="flex items-center gap-2 text-sm text-primary">
                  <CheckCircle2 className="w-4 h-4" />
                  {t("wizard.ssh_success")}
                </div>
              )}
              {sshStatus.state === "error" && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4" />
                  {t("wizard.ssh_failed", { msg: sshStatus.message })}
                </div>
              )}
            </div>

            {/* SSH failure guide: show public key + copy + ssh-copy-id hint */}
            {sshStatus.state === "error" && publicKey && (
              <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground">
                  {t("wizard.ssh_guide_title")}
                </p>
                <div className="relative">
                  <pre className="text-xs bg-background rounded-md p-3 pr-10 overflow-x-auto border border-border font-mono break-all whitespace-pre-wrap">
                    {publicKey}
                  </pre>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 h-7 w-7"
                    onClick={copyPublicKey}
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-primary" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("wizard.ssh_guide_hint")}
                </p>
                <pre className="text-xs bg-background rounded-md p-2 overflow-x-auto border border-border font-mono">
                  ssh-copy-id -i {keyPath} {user ? `${user}@` : ""}{host}
                </pre>
                <p className="text-xs text-muted-foreground">
                  {t("wizard.ssh_guide_or")}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Gateway Config */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              {t("wizard.step2_title")}
            </h2>

            {/* Auto-detect status */}
            {configStatus.state === "reading" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t("wizard.reading_config")}
              </div>
            )}
            {configStatus.state === "success" && (
              <div className="flex items-center gap-2 text-sm text-primary">
                <CheckCircle2 className="w-4 h-4" />
                {t("wizard.config_read_success")}
              </div>
            )}
            {configStatus.state === "error" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertCircle className="w-4 h-4" />
                {t("wizard.config_read_failed")}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                {t("connection.gateway_token")}
              </label>
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t("connection.gateway_token_placeholder")}
                type="password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                  {t("connection.remote_port")}
                </label>
                <Input
                  type="number"
                  value={port}
                  onChange={(e) =>
                    setPort(Number(e.target.value) || 18789)
                  }
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                onClick={testGateway}
                disabled={
                  !token.trim() || wsStatus.state === "testing"
                }
                variant="secondary"
              >
                {wsStatus.state === "testing" && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                {wsStatus.state === "testing"
                  ? t("wizard.testing")
                  : t("wizard.test_gateway")}
              </Button>

              {wsStatus.state === "success" && (
                <div className="flex items-center gap-2 text-sm text-primary">
                  <CheckCircle2 className="w-4 h-4" />
                  {t("wizard.ws_success")}
                </div>
              )}
              {wsStatus.state === "error" && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4" />
                  {t("wizard.ws_failed", { msg: wsStatus.message })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Name & Save */}
        {step === 3 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              {t("wizard.step3_title")}
            </h2>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1.5">
                {t("wizard.profile_name")}
              </label>
              <Input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder={`${user}@${host}`}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom navigation */}
      <div className="flex items-center pt-6 border-t border-border mt-6">
        <Button variant="ghost" onClick={handleCancel}>
          {t("profile.cancel")}
        </Button>

        <div className="flex-1" />

        {step > 1 && (
          <Button variant="outline" onClick={goBack} className="mr-2">
            <ArrowLeft className="w-4 h-4 mr-1" />
            {t("wizard.back")}
          </Button>
        )}

        {step < 3 ? (
          <Button
            onClick={goNext}
            disabled={
              (step === 1 && sshStatus.state !== "success") ||
              (step === 2 && wsStatus.state !== "success")
            }
          >
            {t("wizard.next")}
            <ArrowRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button onClick={handleSave}>
            {t("wizard.save")}
          </Button>
        )}
      </div>
    </div>
  );
}
