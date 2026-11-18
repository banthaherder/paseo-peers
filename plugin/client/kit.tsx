import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useSubscription } from "@getpaseo/plugin/client";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { watchState, type PeersState } from "../shared/contracts";

/** Live plugin state from the daemon. */
export function usePeers(): { state: PeersState | null; error: string | null } {
  const [state, setState] = useState<PeersState | null>(null);
  const subscription = useSubscription(watchState, {}, (event) => setState(event.state));
  const error = subscription.status === "error" ? subscription.error.message : null;
  return { state, error };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function timeLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";

export function Button(props: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  tone?: ButtonTone;
  onPress(): void | Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const { theme, tone = "secondary" } = props;
  const [busy, setBusy] = useState(false);
  const c = theme.colors;
  const background = tone === "primary" ? c.accent : tone === "danger" ? "transparent" : tone === "ghost" ? "transparent" : c.surface2;
  const color = tone === "primary" ? c.accentForeground : tone === "danger" ? c.statusDanger : tone === "ghost" ? c.foregroundMuted : c.foreground;
  const disabled = props.disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={disabled}
      onPress={async () => {
        setBusy(true);
        try {
          await props.onPress();
        } finally {
          setBusy(false);
        }
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: props.compact ? 8 : 12,
        paddingVertical: props.compact ? 4 : 7,
        borderRadius: 8,
        backgroundColor: background,
        borderWidth: tone === "danger" || tone === "ghost" ? 0 : 1,
        borderColor: tone === "primary" ? c.accent : c.border,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : props.icon ? <Icon name={props.icon} size={14} color={color} /> : null}
      <Text style={{ color, fontSize: props.compact ? 12 : 13, fontWeight: tone === "primary" ? "600" : "500" }}>{props.label}</Text>
    </Pressable>
  );
}

export function Badge({ theme, count }: { theme: PluginTheme; count: number }) {
  if (count <= 0) return null;
  return (
    <View style={{ minWidth: 18, paddingHorizontal: 5, height: 18, borderRadius: 9, backgroundColor: theme.colors.accent, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: theme.colors.accentForeground, fontSize: 11, fontWeight: "700" }}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

export function StatusDot({ theme, status }: { theme: PluginTheme; status: PeersState["relay"]["status"] }) {
  const color =
    status === "online" ? theme.colors.statusSuccess : status === "connecting" ? theme.colors.statusWarning : status === "unconfigured" ? theme.colors.foregroundMuted : theme.colors.statusDanger;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export const relayStatusLabel: Record<PeersState["relay"]["status"], string> = {
  online: "Relay connected",
  connecting: "Connecting to relay…",
  offline: "Relay unreachable, retrying",
  unregistered: "Not registered with relay",
  unconfigured: "No relay configured",
};

export function Card({ theme, children, style }: { theme: PluginTheme; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 12, padding: 16, gap: 12 }, style]}>
      {children}
    </View>
  );
}

export function Label({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{children}</Text>;
}

export function inputStyle(theme: PluginTheme, multiline = false) {
  return {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    minHeight: multiline ? 72 : undefined,
    textAlignVertical: multiline ? ("top" as const) : undefined,
  };
}
