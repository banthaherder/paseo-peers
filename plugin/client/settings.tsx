import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import { useRef } from "react";
import { Text, View } from "react-native";
import { configure, setAgentTools } from "../shared/contracts";
import { StatusDot, errorText, relayStatusLabel, usePeers } from "./kit";

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const c = theme.colors;
  const { state, error } = usePeers();
  const save = useRpc(configure);
  const tools = useRpc(setAgentTools);
  const toast = useToast();
  const draft = useRef<{ name?: string; relayUrl?: string; adminToken?: string }>({});

  if (error) return <Text style={{ color: c.statusDanger }}>{error}</Text>;
  if (!state) return <Loading />;

  return (
    <View style={{ gap: 8 }}>
      <SettingsSection title="Identity">
        <SettingsCard>
          <SettingsInput
            label="Display name"
            hint="How peers see you."
            initialValue={state.profile.name}
            onChangeText={(name) => (draft.current.name = name)}
          />
          <SettingsRow label="Key fingerprint" hint="Compare with your peer's view if you want to verify the pairing.">
            <Text selectable style={{ color: c.foreground, fontFamily: "Menlo" }}>
              {state.identity.fingerprint}
            </Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Relay">
        <SettingsCard>
          <SettingsRow label="Status" hint={state.relay.status !== "online" ? (state.relay.lastError ?? undefined) : undefined}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <StatusDot theme={theme} status={state.relay.status} />
              <Text style={{ color: c.foreground }}>{relayStatusLabel[state.relay.status]}</Text>
            </View>
          </SettingsRow>
          <SettingsInput
            label="Relay URL"
            hint="Changing it requires re-pairing peers."
            initialValue={state.relay.url ?? ""}
            placeholder="https://relay.example.com"
            onChangeText={(url) => (draft.current.relayUrl = url)}
          />
          <SettingsInput
            label="Admin token"
            hint={state.relay.hasAdminToken ? "Saved. Type a new one to replace it, or a single space to remove it." : "The relay's RELAY_ADMIN_TOKEN, only on the owner's install. Not an invite code: paste those on the Peers screen under Join."}
            secureTextEntry
            onChangeText={(token) => (draft.current.adminToken = token)}
          />
          <SettingsAction
            label="Save identity and relay"
            actionLabel="Save"
            onPress={async () => {
              const input = { ...draft.current };
              if (input.adminToken === "") delete input.adminToken;
              if (input.name !== undefined && !input.name.trim()) delete input.name;
              try {
                await save(input);
                draft.current = {};
                toast.show("Saved", { variant: "success" });
              } catch (e) {
                toast.error(errorText(e));
              }
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Agents">
        <SettingsCard>
          <SettingsSwitch
            label="Give agents peer tools"
            hint="Adds peer_send, peer_inbox and peer_list to your agents once a relay is set. Agents get them when their session next opens."
            value={state.agentTools === "all"}
            onValueChange={async (on) => {
              try {
                await tools({ mode: on ? "all" : "off" });
              } catch (e) {
                toast.error(errorText(e));
              }
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
